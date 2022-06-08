import { LensHubProxy } from '@abis/LensHubProxy'
import { gql, useMutation, useQuery } from '@apollo/client'
import { ALLOWANCE_SETTINGS_QUERY } from '@components/Settings/Allowance'
import AllowanceButton from '@components/Settings/Allowance/Button'
import Collectors from '@components/Shared/Collectors'
import IndexStatus from '@components/Shared/IndexStatus'
import Loader from '@components/Shared/Loader'
import ReferenceAlert from '@components/Shared/ReferenceAlert'
import ReferralAlert from '@components/Shared/ReferralAlert'
import Uniswap from '@components/Shared/Uniswap'
import { Button } from '@components/UI/Button'
import { Modal } from '@components/UI/Modal'
import { Spinner } from '@components/UI/Spinner'
import { Tooltip } from '@components/UI/Tooltip'
import { WarningMessage } from '@components/UI/WarningMessage'
import AppContext from '@components/utils/AppContext'
import { BCharityPost } from '@generated/bcharitytypes'
import { CreateCollectBroadcastItemResult } from '@generated/types'
import { BROADCAST_MUTATION } from '@gql/BroadcastMutation'
import { CollectModuleFields } from '@gql/CollectModuleFields'
import {
  CashIcon,
  ClockIcon,
  CollectionIcon,
  PhotographIcon,
  PuzzleIcon,
  UserIcon,
  UsersIcon
} from '@heroicons/react/outline'
import consoleLog from '@lib/consoleLog'
import formatAddress from '@lib/formatAddress'
import getTokenImage from '@lib/getTokenImage'
import omit from '@lib/omit'
import splitSignature from '@lib/splitSignature'
import trackEvent from '@lib/trackEvent'
import dayjs from 'dayjs'
import React, { Dispatch, FC, useContext, useState } from 'react'
import toast from 'react-hot-toast'
import {
  CHAIN_ID,
  CONNECT_WALLET,
  ERROR_MESSAGE,
  LENSHUB_PROXY,
  POLYGONSCAN_URL,
  RELAY_ON,
  WRONG_NETWORK
} from 'src/constants'
import {
  useAccount,
  useBalance,
  useContractWrite,
  useNetwork,
  useSignTypedData
} from 'wagmi'

export const COLLECT_QUERY = gql`
  query CollectModule($request: PublicationQueryRequest!) {
    publication(request: $request) {
      ... on Post {
        collectNftAddress
        collectModule {
          ...CollectModuleFields
        }
      }
      ... on Comment {
        collectNftAddress
        collectModule {
          ...CollectModuleFields
        }
      }
      ... on Mirror {
        collectNftAddress
        collectModule {
          ...CollectModuleFields
        }
      }
    }
  }
  ${CollectModuleFields}
`

const CREATE_COLLECT_TYPED_DATA_MUTATION = gql`
  mutation CreateCollectTypedData($request: CreateCollectRequest!) {
    createCollectTypedData(request: $request) {
      id
      expiresAt
      typedData {
        types {
          CollectWithSig {
            name
            type
          }
        }
        domain {
          name
          chainId
          version
          verifyingContract
        }
        value {
          nonce
          deadline
          profileId
          pubId
          data
        }
      }
    }
  }
`

interface Props {
  count: number
  setCount: Dispatch<number>
  post: BCharityPost
}

const CollectModule: FC<Props> = ({ count, setCount, post }) => {
  const { currentUser } = useContext(AppContext)
  const [showCollectorsModal, setShowCollectorsModal] = useState<boolean>(false)
  const [allowed, setAllowed] = useState<boolean>(true)

  const { activeChain } = useNetwork()
  const { data: account } = useAccount()
  const { isLoading: signLoading, signTypedDataAsync } = useSignTypedData({
    onError(error) {
      toast.error(error?.message)
    }
  })

  const onCompleted = () => {
    // setShowCollectModal && setShowCollectModal(false)
    setCount(count + 1)
    toast.success('Transaction submitted successfully!')
    trackEvent('collect publication')
  }

  const {
    data: writeData,
    isLoading: writeLoading,
    write
  } = useContractWrite(
    {
      addressOrName: LENSHUB_PROXY,
      contractInterface: LensHubProxy
    },
    'collectWithSig',
    {
      onSuccess() {
        onCompleted()
      },
      onError(error: any) {
        toast.error(error?.data?.message ?? error?.message)
      }
    }
  )

  const { data, loading } = useQuery(COLLECT_QUERY, {
    variables: { request: { publicationId: post?.id } },
    skip: !post?.id,
    onCompleted() {
      consoleLog(
        'Query',
        '#8b5cf6',
        `Fetched collect module details Publication:${post?.id}`
      )
    }
  })

  const collectModule: any = data?.publication?.collectModule
  const percentageCollected =
    (count / parseInt(collectModule?.collectLimit)) * 100

  const { data: allowanceData, loading: allowanceLoading } = useQuery(
    ALLOWANCE_SETTINGS_QUERY,
    {
      variables: {
        request: {
          currencies: collectModule?.amount?.asset?.address,
          followModules: [],
          collectModules: collectModule?.type,
          referenceModules: []
        }
      },
      skip: !collectModule?.amount?.asset?.address || !currentUser,
      onCompleted(data) {
        setAllowed(data?.approvedModuleAllowanceAmount[0]?.allowance !== '0x00')
        consoleLog('Query', '#8b5cf6', `Fetched allowance data`)
      }
    }
  )

  const { data: balanceData, isLoading: balanceLoading } = useBalance({
    addressOrName: currentUser?.ownedBy,
    token: collectModule?.amount?.asset?.address
  })
  let hasAmount = false

  if (
    balanceData &&
    parseFloat(balanceData?.formatted) <
      parseFloat(collectModule?.amount?.value)
  ) {
    hasAmount = false
  } else {
    hasAmount = true
  }

  const [broadcast, { data: broadcastData, loading: broadcastLoading }] =
    useMutation(BROADCAST_MUTATION, {
      onCompleted({ broadcast }) {
        if (broadcast?.reason !== 'NOT_ALLOWED') {
          onCompleted()
        }
      },
      onError(error) {
        consoleLog('Relay Error', '#ef4444', error.message)
      }
    })
  const [createCollectTypedData, { loading: typedDataLoading }] = useMutation(
    CREATE_COLLECT_TYPED_DATA_MUTATION,
    {
      onCompleted({
        createCollectTypedData
      }: {
        createCollectTypedData: CreateCollectBroadcastItemResult
      }) {
        consoleLog('Mutation', '#4ade80', 'Generated createCollectTypedData')
        const { id, typedData } = createCollectTypedData

        signTypedDataAsync({
          domain: omit(typedData?.domain, '__typename'),
          types: omit(typedData?.types, '__typename'),
          value: omit(typedData?.value, '__typename')
        }).then((signature) => {
          const { profileId, pubId, data: collectData } = typedData?.value
          const { v, r, s } = splitSignature(signature)
          const sig = { v, r, s, deadline: typedData.value.deadline }
          const inputStruct = {
            collector: account?.address,
            profileId,
            pubId,
            data: collectData,
            sig
          }
          if (RELAY_ON) {
            broadcast({ variables: { request: { id, signature } } }).then(
              ({ data: { broadcast }, errors }) => {
                if (errors || broadcast?.reason === 'NOT_ALLOWED') {
                  write({ args: inputStruct })
                }
              }
            )
          } else {
            write({ args: inputStruct })
          }
        })
      },
      onError(error) {
        toast.error(error.message ?? ERROR_MESSAGE)
      }
    }
  )

  const createCollect = () => {
    // TODO: Add time check
    if (!account?.address) {
      toast.error(CONNECT_WALLET)
    } else if (activeChain?.id !== CHAIN_ID) {
      toast.error(WRONG_NETWORK)
    } else if (parseInt(collectModule?.collectLimit) <= count) {
      toast.error('Collect limit reached for this publication!')
    } else {
      createCollectTypedData({
        variables: { request: { publicationId: post?.id } }
      })
    }
  }

  if (loading) return <Loader message="Loading collect" />

  return (
    <>
      {(collectModule?.type === 'LimitedFeeCollectModule' ||
        collectModule?.type === 'LimitedTimedFeeCollectModule') && (
        <Tooltip
          placement="top"
          content={`${percentageCollected.toFixed(0)}% Collected`}
        >
          <div className="w-full h-2.5 bg-gray-200 dark:bg-gray-700">
            <div
              className="h-2.5 bg-brand-500"
              style={{ width: `${percentageCollected}%` }}
            />
          </div>
        </Tooltip>
      )}
      <div className="p-5">
        {collectModule?.followerOnly && (
          <div className="pb-5">
            <ReferenceAlert
              handle={post?.profile?.handle}
              isSuperFollow={
                post?.profile?.followModule?.__typename ===
                'FeeFollowModuleSettings'
              }
              action="collect"
            />
          </div>
        )}
        <div className="pb-2 space-y-1.5">
          {post?.metadata?.name && (
            <div className="text-xl font-bold">{post?.metadata?.name}</div>
          )}
          {post?.metadata?.description && (
            <div className="text-gray-500 line-clamp-2">
              {post?.metadata?.description}
            </div>
          )}
          <ReferralAlert
            mirror={post}
            referralFee={collectModule?.referralFee}
          />
        </div>
        {collectModule?.amount && (
          <div className="flex items-center py-2 space-x-1.5">
            <img
              className="w-7 h-7"
              height={28}
              width={28}
              src={getTokenImage(collectModule?.amount?.asset?.symbol)}
              alt={collectModule?.amount?.asset?.symbol}
              title={collectModule?.amount?.asset?.symbol}
            />
            <span className="space-x-1">
              <span className="text-2xl font-bold">
                {collectModule.amount.value}
              </span>
              <span className="text-xs">
                {collectModule?.amount?.asset?.symbol}
              </span>
            </span>
          </div>
        )}
        <div className="space-y-1.5">
          <div className="block space-y-1 sm:flex sm:space-x-5 item-center">
            <div className="flex items-center space-x-2">
              <UsersIcon className="w-4 h-4 text-gray-500" />
              <button
                className="font-bold"
                type="button"
                onClick={() => setShowCollectorsModal(!showCollectorsModal)}
              >
                {count} collectors
              </button>
              <Modal
                title="Collectors"
                icon={<CollectionIcon className="w-5 h-5 text-brand" />}
                show={showCollectorsModal}
                onClose={() => setShowCollectorsModal(!showCollectorsModal)}
              >
                <Collectors pubId={post?.id} />
              </Modal>
            </div>
            {collectModule?.collectLimit && (
              <div className="flex items-center space-x-2">
                <PhotographIcon className="w-4 h-4 text-gray-500" />
                <div className="font-bold">
                  {parseInt(collectModule?.collectLimit) - count} available
                </div>
              </div>
            )}
            {collectModule?.referralFee ? (
              <div className="flex items-center space-x-2">
                <CashIcon className="w-4 h-4 text-gray-500" />
                <div className="font-bold">
                  {collectModule.referralFee}% referral fee
                </div>
              </div>
            ) : null}
          </div>
          <div>
            {collectModule?.endTimestamp && (
              <div className="flex items-center space-x-2">
                <ClockIcon className="w-4 h-4 text-gray-500" />
                <div className="space-x-1.5">
                  <span>Sale Ends</span>
                  <span className="font-bold text-gray-600">
                    {dayjs(collectModule.endTimestamp).format('MMMM DD, YYYY')}{' '}
                    at {dayjs(collectModule.endTimestamp).format('hh:mm a')}
                  </span>
                </div>
              </div>
            )}
          </div>
          {collectModule?.recipient && (
            <div className="flex items-center space-x-2">
              <UserIcon className="w-4 h-4 text-gray-500" />
              <div className="space-x-1.5">
                <span>Recipient:</span>
                <a
                  href={`${POLYGONSCAN_URL}/address/${collectModule.recipient}`}
                  target="_blank"
                  className="font-bold text-gray-600"
                  rel="noreferrer noopener"
                >
                  {formatAddress(collectModule.recipient)}
                </a>
              </div>
            </div>
          )}
          {data?.publication?.collectNftAddress && (
            <div className="flex items-center space-x-2">
              <PuzzleIcon className="w-4 h-4 text-gray-500" />
              <div className="space-x-1.5">
                <span>Contract:</span>
                <a
                  href={`${POLYGONSCAN_URL}/token/${data?.publication?.collectNftAddress}`}
                  target="_blank"
                  className="font-bold text-gray-600"
                  rel="noreferrer noopener"
                >
                  {formatAddress(data?.publication?.collectNftAddress)}
                </a>
              </div>
            </div>
          )}
        </div>
        {writeData?.hash ?? broadcastData?.broadcast?.txHash ? (
          <div className="mt-5">
            <IndexStatus
              txHash={
                writeData?.hash
                  ? writeData?.hash
                  : broadcastData?.broadcast?.txHash
              }
            />
          </div>
        ) : null}
        {currentUser ? (
          allowanceLoading || balanceLoading ? (
            <div className="mt-5 w-28 rounded-lg h-[34px] shimmer" />
          ) : allowed || collectModule.type === 'FreeCollectModule' ? (
            hasAmount ? (
              <Button
                className="mt-5"
                onClick={createCollect}
                disabled={
                  typedDataLoading ||
                  signLoading ||
                  writeLoading ||
                  broadcastLoading
                }
                icon={
                  typedDataLoading ||
                  signLoading ||
                  writeLoading ||
                  broadcastLoading ? (
                    <Spinner size="xs" />
                  ) : (
                    <CollectionIcon className="w-4 h-4" />
                  )
                }
              >
                Collect now
              </Button>
            ) : (
              <WarningMessage
                className="mt-5"
                message={<Uniswap module={collectModule} />}
              />
            )
          ) : (
            <div className="mt-5">
              <AllowanceButton
                title="Allow collect module"
                module={allowanceData?.approvedModuleAllowanceAmount[0]}
                allowed={allowed}
                setAllowed={setAllowed}
              />
            </div>
          )
        ) : null}
      </div>
    </>
  )
}

export default CollectModule
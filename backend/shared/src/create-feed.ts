import {
  createSupabaseDirectClient,
  pgp,
  SupabaseDirectClient,
} from 'shared/supabase/init'
import { Comment, ContractComment } from 'common/comment'
import {
  getUsersWithSimilarInterestVectorsToContract,
  getUserToReasonsInterestedInContractAndUser,
} from 'shared/supabase/contracts'
import { Contract, CPMMContract } from 'common/contract'
import {
  ALL_FEED_USER_ID,
  CONTRACT_FEED_REASON_TYPES,
  FEED_DATA_TYPES,
  FEED_REASON_TYPES,
  getRelevanceScore,
  INTEREST_DISTANCE_THRESHOLDS,
} from 'common/feed'
import { getContractSupabase, log } from 'shared/utils'
import { getUserFollowerIds } from 'shared/supabase/users'
import { convertObjectToSQLRow, Row } from 'common/supabase/utils'
import { DAY_MS } from 'common/util/time'
import { User } from 'common/user'
import { fromPairs, groupBy, maxBy, uniq } from 'lodash'
import { removeUndefinedProps } from 'common/util/object'
import { PositionChangeData } from 'common/supabase/bets'
import { filterDefined } from 'common/util/array'

export const bulkInsertDataToUserFeed = async (
  usersToReasonsInterestedInContract: {
    [userId: string]: {
      reasons: FEED_REASON_TYPES[]
      relevanceScore: number
    }
  },
  eventTime: number,
  dataType: FEED_DATA_TYPES,
  userIdsToExclude: string[],
  dataProps: {
    contractId?: string
    commentId?: string
    answerIds?: string[]
    creatorId?: string
    newsId?: string
    data?: any
    groupId?: string
    reactionId?: string
    idempotencyKey?: string
    betData?: any
    postId?: number
  },
  pg: SupabaseDirectClient
) => {
  const eventTimeTz = new Date(eventTime).toISOString()

  const feedRows = Object.entries(usersToReasonsInterestedInContract)
    .filter(([userId]) => !userIdsToExclude.includes(userId))
    .concat([
      [
        ALL_FEED_USER_ID,
        { reasons: ['similar_interest_vector_to_contract'], relevanceScore: 1 },
      ],
    ])
    .map(([userId, reasonAndScore]) =>
      convertObjectToSQLRow<any, 'user_feed'>({
        ...dataProps,
        userId,
        ...reasonAndScore,
        reason: reasonAndScore.reasons[0],
        dataType,
        eventTime: eventTimeTz,
      })
    )
  if (feedRows.length === 0) return
  const cs = new pgp.helpers.ColumnSet(feedRows[0], { table: 'user_feed' })
  const insert = pgp.helpers.insert(feedRows, cs) + ` ON CONFLICT DO NOTHING`

  const maxRetries = 3
  let retries = 0
  while (retries < maxRetries) {
    try {
      await pg.none(insert)
      log(`inserted ${feedRows.length} feed items`)
      break // Exit if successful
    } catch (e) {
      retries++
      log(`error inserting feed items, retrying ${retries}/${maxRetries}`)
      log(e)
      await new Promise((r) => setTimeout(r, 1000 * retries + 1000))
    }
  }
  if (retries === maxRetries)
    log(`Failed to insert feed items after ${maxRetries} attempts`)
}

export const createManualTrendingFeedRow = (
  contracts: Contract[],
  forUserId: string,
  estimatedRelevance: number
) => {
  const now = Date.now()
  const reasons: FEED_REASON_TYPES[] = [
    'similar_interest_vector_to_contract',
    'contract_in_group_you_are_in',
  ]
  return contracts.map(
    (contract) =>
      convertObjectToSQLRow<any, 'user_feed'>({
        contractId: contract.id,
        creatorId: contract.creatorId,
        userId: forUserId,
        eventTime: new Date(now).toISOString(),
        reason: 'similar_interest_vector_to_contract',
        dataType: 'trending_contract',
        reasons,
        relevanceScore: contract.importanceScore * estimatedRelevance,
      }) as Row<'user_feed'>
  )
}

const matchingFeedRows = async (
  contractId: string,
  userIds: string[],
  seenTime: number,
  dataTypes: FEED_DATA_TYPES[],
  pg: SupabaseDirectClient
) => {
  return await pg.map(
    `select *
            from user_feed
            where contract_id = $1 and
                user_id = ANY($2) and
                greatest(created_time, seen_time) > $3 and
                data_type = ANY($4)
                `,
    [contractId, userIds, new Date(seenTime).toISOString(), dataTypes],
    (row) => row as Row<'user_feed'>
  )
}

const userIdsToIgnore = async (
  contractId: string,
  userIds: string[],
  seenTime: number,
  dataTypes: FEED_DATA_TYPES[],
  pg: SupabaseDirectClient
) => {
  const userIdsWithSeenMarkets = await pg.map(
    `select distinct user_id
            from user_seen_markets
            where contract_id = $1 and
                user_id = ANY($2) and
                created_time > $3
                `,
    [contractId, userIds, new Date(seenTime).toISOString(), dataTypes],
    (row: { user_id: string }) => row.user_id
  )
  const userIdsWithFeedRows = await pg.map(
    `select distinct user_id
            from user_feed
            where contract_id = $1 and
                user_id = ANY($2) and
                greatest(created_time, seen_time) > $3 and
                data_type = ANY($4)
                `,
    [
      contractId,
      userIds.filter((id) => !userIdsWithSeenMarkets.includes(id)),
      new Date(seenTime).toISOString(),
      dataTypes,
    ],
    (row: { user_id: string }) => row.user_id
  )
  return userIdsWithFeedRows.concat(userIdsWithSeenMarkets)
}

export const addCommentOnContractToFeed = async (
  contract: Contract,
  comment: ContractComment,
  userIdsToExclude: string[],
  idempotencyKey?: string
) => {
  if (comment.isRepost || comment.replyToCommentId) return
  const pg = createSupabaseDirectClient()
  const usersToReasonsInterestedInContract =
    await getUserToReasonsInterestedInContractAndUser(
      contract,
      comment.userId,
      pg,
      ['follow_contract'],
      false,
      'new_comment'
    )
  await bulkInsertDataToUserFeed(
    usersToReasonsInterestedInContract,
    comment.createdTime,
    'new_comment',
    userIdsToExclude,
    {
      contractId: contract.id,
      commentId: comment.id,
      creatorId: comment.userId,
      idempotencyKey,
    },
    pg
  )
}

export const repostContractToFeed = async (
  contract: Contract,
  comment: Comment,
  postId: number,
  userIdsToExclude: string[],
  idempotencyKey?: string
) => {
  const pg = createSupabaseDirectClient()
  const usersToReasonsInterestedInContract =
    await getUserToReasonsInterestedInContractAndUser(
      contract,
      comment.userId,
      pg,
      [
        'follow_user',
        'follow_contract', // unsure which of these will work besides follow_user
        'contract_in_group_you_are_in',
        'similar_interest_vector_to_contract',
      ],
      false,
      'repost',
      0.15
    )
  await bulkInsertDataToUserFeed(
    usersToReasonsInterestedInContract,
    comment.createdTime,
    'repost',
    userIdsToExclude,
    {
      contractId: contract.id,
      commentId: comment.id,
      creatorId: comment.userId,
      idempotencyKey,
      postId,
    },
    pg
  )
}

export const addContractToFeed = async (
  contract: Contract,
  reasonsToInclude: CONTRACT_FEED_REASON_TYPES[],
  dataType: FEED_DATA_TYPES,
  userIdsToExclude: string[],
  options: {
    userIdResponsibleForEvent?: string
    idempotencyKey?: string
  }
) => {
  const { idempotencyKey, userIdResponsibleForEvent } = options
  const pg = createSupabaseDirectClient()
  const usersToReasonsInterestedInContract =
    await getUserToReasonsInterestedInContractAndUser(
      contract,
      userIdResponsibleForEvent ?? contract.creatorId,
      pg,
      reasonsToInclude,
      false,
      dataType,
      0.2
    )
  await bulkInsertDataToUserFeed(
    usersToReasonsInterestedInContract,
    contract.createdTime,
    dataType,
    userIdsToExclude,
    {
      contractId: contract.id,
      creatorId: contract.creatorId,
      idempotencyKey,
    },
    pg
  )
  log(
    `Added contract ${contract.id} to feed of ${
      Object.keys(usersToReasonsInterestedInContract).length
    } users`
  )
}

export const addContractToFeedIfNotDuplicative = async (
  contract: Contract,
  reasonsToInclude: CONTRACT_FEED_REASON_TYPES[],
  dataType: FEED_DATA_TYPES,
  userIdsToExclude: string[],
  unseenNewerThanTime: number,
  data?: Record<string, any>,
  trendingContractType?: 'old' | 'new'
) => {
  const pg = createSupabaseDirectClient()
  const usersToReasonsInterestedInContract =
    await getUserToReasonsInterestedInContractAndUser(
      contract,
      contract.creatorId,
      pg,
      reasonsToInclude,
      true,
      dataType,
      undefined,
      trendingContractType
    )
  log(
    'checking users for feed rows:',
    Object.keys(usersToReasonsInterestedInContract).length
  )

  const ignoreUserIds = await userIdsToIgnore(
    contract.id,
    Object.keys(usersToReasonsInterestedInContract),
    unseenNewerThanTime,
    [dataType, 'new_contract', 'new_subsidy'],
    pg
  )

  await bulkInsertDataToUserFeed(
    usersToReasonsInterestedInContract,
    contract.createdTime,
    dataType,
    userIdsToExclude.concat(ignoreUserIds),
    {
      contractId: contract.id,
      creatorId: contract.creatorId,
      data,
    },
    pg
  )
}

export const insertMarketMovementContractToUsersFeeds = async (
  contract: CPMMContract
) => {
  await addContractToFeedIfNotDuplicative(
    contract,
    [
      'follow_contract',
      'liked_contract',
      'similar_interest_vector_to_contract',
      'contract_in_group_you_are_in',
    ],
    'contract_probability_changed',
    [],
    Date.now() - 1.5 * DAY_MS,
    {
      currentProb: contract.prob,
      previousProb: contract.prob - contract.probChanges.day,
    }
  )
}
export const insertTrendingContractToUsersFeeds = async (
  contract: Contract,
  unseenNewerThanTime: number,
  data?: Record<string, any>,
  trendingContractType?: 'old' | 'new'
) => {
  await addContractToFeedIfNotDuplicative(
    contract,
    [
      'follow_contract',
      'liked_contract',
      'similar_interest_vector_to_contract',
      'contract_in_group_you_are_in',
    ],
    'trending_contract',
    [contract.creatorId],
    unseenNewerThanTime,
    data,
    trendingContractType
  )
}

export const addBetDataToUsersFeeds = async (
  contractId: string,
  bettor: User,
  betData: PositionChangeData,
  idempotencyKey: string
) => {
  const pg = createSupabaseDirectClient()
  // Need contract from supabase for importance score
  const contract = await getContractSupabase(contractId)
  if (!contract) return
  const now = Date.now()
  let followerIds = await getUserFollowerIds(bettor.id, pg)
  // let followerIds = ['mwaVAaKkabODsH8g5VrtbshsXz03']
  const oldMatchingPositionChangedRows = await matchingFeedRows(
    contract.id,
    followerIds,
    now - DAY_MS,
    ['user_position_changed'],
    pg
  )
  const oldRowsByUserId = groupBy(oldMatchingPositionChangedRows, 'user_id')
  const feedRowIdsToDelete: number[] = []
  Object.entries(oldRowsByUserId).forEach(([userId, rows]) => {
    const oldMaxChange = maxBy(rows, (r) =>
      r.bet_data ? Math.abs((r.bet_data as PositionChangeData).change) : 0
    )
    // No old row
    if (!oldMaxChange) return
    // Old row is more important, or has already been seen
    if (
      Math.abs((oldMaxChange.bet_data as PositionChangeData).change) >=
        Math.abs(betData.change) ||
      oldMaxChange.seen_time
    ) {
      followerIds = followerIds.filter((id) => id !== userId)
    }
    // New row is more important
    else {
      feedRowIdsToDelete.push(...rows.map((r) => r.id))
    }
  })
  await deleteRowsFromUserFeed(feedRowIdsToDelete, pg)
  const usersToDistances = await getUsersWithSimilarInterestVectorsToContract(
    contract.id,
    pg,
    INTEREST_DISTANCE_THRESHOLDS.user_position_changed,
    20,
    followerIds
  )

  await bulkInsertDataToUserFeed(
    fromPairs(
      followerIds.map((id) => [
        id,
        {
          reasons: ['follow_user'],
          relevanceScore: getRelevanceScore(
            'user_position_changed',
            ['follow_user'],
            contract.importanceScore,
            usersToDistances[id] ?? 1
          ),
        },
      ])
    ),
    now,
    'user_position_changed',
    [],
    removeUndefinedProps({
      contractId: contract.id,
      creatorId: bettor.id,
      betData: removeUndefinedProps(betData),
      answerIds: filterDefined(
        uniq([betData.current?.answerId, betData.previous?.answerId])
      ),
      idempotencyKey,
    }),
    pg
  )
}

const deleteRowsFromUserFeed = async (
  rowIds: number[],
  pg: SupabaseDirectClient
) => {
  if (rowIds.length === 0) return
  await pg.none(`delete from user_feed where id = any($1)`, [rowIds])
}

// Currently creating feed items for:
// - New comments on contracts you follow/liked/viewed/from users you follow
// - Liked comments from likers you follow/have similar interest vectors to and
// on contracts that you've similar interest vectors to/groups you're in
// - New contracts with similar interest vector/from users you follow/you have similar interest vectors to
// - Contracts with large prob changes

// TODO:
// Create feed items from:
// - Large bets by interesting users
// Remove comment notifications

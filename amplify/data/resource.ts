import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  UserProfile: a
    .model({
      userId: a.string().required(),
      email: a.email(),
      displayName: a.string().required(),
      avatarKey: a.string(),
      statusMessage: a.string(),
    })
    .secondaryIndexes((index) => [index('userId')])
    .authorization((allow) => [
      allow.ownerDefinedIn('userId').identityClaim('sub'),
      allow.authenticated().to(['read']),
    ]),

  FriendRequest: a
    .model({
      fromUserId: a.string().required(),
      fromDisplayName: a.string().required(),
      fromAvatarKey: a.string(),
      toUserId: a.string().required(),
      toDisplayName: a.string().required(),
      toAvatarKey: a.string(),
      status: a.enum(['PENDING', 'ACCEPTED', 'REJECTED']),
      participantIds: a.string().array().required(),
      conversationId: a.id(),
      createdAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('fromUserId'),
      index('toUserId'),
    ])
    .authorization((allow) => [
      allow.ownersDefinedIn('participantIds').identityClaim('sub'),
    ]),

  Contact: a
    .model({
      ownerId: a.string().required(),
      contactUserId: a.string().required(),
      displayName: a.string().required(),
      avatarKey: a.string(),
      conversationId: a.id(),
      lastReadAt: a.datetime(),
    })
    .secondaryIndexes((index) => [
      index('ownerId'),
      index('contactUserId'),
      index('conversationId'),
    ])
    .authorization((allow) => [
      allow.ownerDefinedIn('ownerId').identityClaim('sub'),
    ]),

  Conversation: a
    .model({
      type: a.enum(['DIRECT']),
      memberIds: a.string().array().required(),
      deletedByUserIds: a.string().array(),
      lastMessageText: a.string(),
      lastMessageAt: a.datetime(),
    })
    .authorization((allow) => [
      allow.ownersDefinedIn('memberIds').identityClaim('sub'),
    ]),

  Message: a
    .model({
      conversationId: a.id().required(),
      senderId: a.string().required(),
      senderName: a.string().required(),
      body: a.string().required(),
      messageType: a.enum(['TEXT', 'IMAGE']),
      imageKey: a.string(),
      createdAt: a.datetime().required(),
      memberIds: a.string().array(),
    })
    .secondaryIndexes((index) => [
      index('conversationId').sortKeys(['createdAt']),
      index('senderId'),
    ])
    .authorization((allow) => [
      allow.ownersDefinedIn('memberIds').identityClaim('sub'),
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});

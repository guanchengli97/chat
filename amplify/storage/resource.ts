import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'chatMedia',
  access: (allow) => ({
    'avatars/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.authenticated.to(['read']),
    ],
    'messages/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.authenticated.to(['read']),
    ],
  }),
});

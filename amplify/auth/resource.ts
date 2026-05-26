import { defineAuth } from '@aws-amplify/backend';
import { onUserSignUp } from '../functions/on-user-sign-up/resource';

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  triggers: {
    postConfirmation: onUserSignUp,
  },
});

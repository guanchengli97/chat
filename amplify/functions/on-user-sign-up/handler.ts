export const handler = async (event: {
  userName?: string;
  request?: { userAttributes?: Record<string, string | undefined> };
}) => {
  const email = event.request?.userAttributes?.email;
  console.log('User confirmed sign up', {
    userName: event.userName,
    email,
  });

  return event;
};

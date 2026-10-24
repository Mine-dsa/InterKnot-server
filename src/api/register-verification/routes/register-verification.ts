export default {
  routes: [
    {
      method: 'POST',
      path: '/auth/send-register-code',
      handler: 'register-verification.sendRegisterCode',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/auth/register-with-code',
      handler: 'register-verification.registerWithCode',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/auth/send-reset-code',
      handler: 'register-verification.sendResetCode',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/auth/reset-password',
      handler: 'register-verification.resetPasswordWithCode',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/auth/renew',
      handler: 'register-verification.renewToken',
      config: {
        auth: {},
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/auth/register',
      handler: 'register-verification.simpleRegister',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};

export default {
  routes: [
    {
      method: 'POST',
      path: '/direct-upload/sign',
      handler: 'direct-upload.sign',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::require-exam-passed'],
      },
    },
    {
      method: 'POST',
      path: '/direct-upload/complete',
      handler: 'direct-upload.complete',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::require-exam-passed'],
      },
    },
    {
      method: 'PUT',
      path: '/direct-upload/upload-file/:token',
      handler: 'direct-upload.localUpload',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};

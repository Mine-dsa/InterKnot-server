import { mergeConfig, type UserConfig } from 'vite';

export default (config: UserConfig) => {
  // Important: always return the modified config
  return mergeConfig(config, {
    server: {
      // 允许特定的域名，或设置为 true 以允许所有主机名
      allowedHosts: true,
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  });
};
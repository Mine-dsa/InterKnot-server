type UploadPlugin = {
  contentTypes?: {
    file?: {
      schema?: {
        attributes?: Record<string, unknown>;
      };
    };
  };
};

export default (plugin: UploadPlugin) => {
  const fileAttributes = plugin.contentTypes?.file?.schema?.attributes;
  if (!fileAttributes) {
    return plugin;
  }

  // 多对多：内容去重时同一文件会被多个用户"上传"，需要全部记录
  //   - 用户侧：可作为"我的图库"列出自己曾上传/复用过的全部图片
  //   - 审核侧：违规图片可枚举所有上传者
  // 标记 private + 禁止外部写入：避免通过 Content API populate 反向暴露上传者，
  // 防止匿名发帖功能被溯源到真实账号；归属仅由后端服务写入。
  fileAttributes.uploaders = {
    type: 'relation',
    relation: 'manyToMany',
    target: 'plugin::users-permissions.user',
    configurable: false,
    private: true,
    writable: false,
    visible: false,
  };

  return plugin;
};

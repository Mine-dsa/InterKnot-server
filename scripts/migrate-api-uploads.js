'use strict';

/**
 * 一次性迁移 + 修复脚本：
 *   1) 把 API Uploads 根目录下的存量文件按 createdAt 归类到 YYYY/MM 子文件夹；
 *   2) 修复 file.folder 关系（manyToOne 走 join table，必须直接写 link 表）。
 *
 * 仅迁移 DB 文件夹归属（folder / folderPath），
 * 不改动 S3 上的物理对象与 file.url，外链保持有效。
 *
 * 幂等：脚本会从 root 与已存在的年月子文件夹中重新对齐 link 表，
 * 重复运行不会引发错误，可用于修复上一版只更新 folderPath 未更新关系表的问题。
 *
 * 用法：
 *   node ./scripts/migrate-api-uploads.js          # 实际执行
 *   node ./scripts/migrate-api-uploads.js --dry    # 仅打印计划，不写库
 */

const FOLDER_UID = 'plugin::upload.folder';
const FILE_UID = 'plugin::upload.file';

const DRY_RUN = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const BATCH_SIZE = 200;

const pad2 = (n) => String(n).padStart(2, '0');

const getYearMonth = (file) => {
  const raw = file.createdAt || file.updatedAt;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return { year: String(now.getFullYear()), month: pad2(now.getMonth() + 1) };
  }
  return { year: String(date.getFullYear()), month: pad2(date.getMonth() + 1) };
};

async function findOrCreateSubfolder(parent, name) {
  const existing = await strapi.db.query(FOLDER_UID).findOne({
    where: { name, parent: parent.id },
  });
  if (existing) return existing;

  if (DRY_RUN) {
    return { id: -1, name, parent: parent.id, path: `${parent.path}/<new>`, __dry: true };
  }

  const folderService = strapi.plugin('upload').service('folder');
  try {
    return await folderService.create({ name, parent: parent.id });
  } catch (error) {
    const retry = await strapi.db.query(FOLDER_UID).findOne({
      where: { name, parent: parent.id },
    });
    if (retry) return retry;
    throw error;
  }
}

/**
 * 直接对 file.folder 的 join table 做"删旧插新"，等价于 Strapi 后台的 move 操作。
 * - manyToOne 关系在 v5 默认走 link table，标量 update 不会写到这里；
 * - 同时把扁平列 folderPath 也对齐，便于按路径筛查与未来层级移动。
 */
async function reassignFilesToFolder(fileIds, destFolder) {
  if (!fileIds.length) return 0;

  const fileMeta = strapi.db.metadata.get(FILE_UID);
  const joinTable = fileMeta.attributes.folder.joinTable;
  if (!joinTable) {
    throw new Error('file.folder has no joinTable; Strapi internal layout changed?');
  }
  const folderPathColumn = fileMeta.attributes.folderPath.columnName;
  const fileTable = fileMeta.tableName;

  await strapi.db.transaction(async ({ trx }) => {
    // 删除所有旧的 link（无论原本指向哪个 folder），再批量插入新的，等价于 set 语义。
    await strapi.db
      .getConnection(joinTable.name)
      .transacting(trx)
      .whereIn(joinTable.joinColumn.name, fileIds)
      .delete();

    await strapi.db
      .getConnection(joinTable.name)
      .transacting(trx)
      .insert(
        fileIds.map((id) => ({
          [joinTable.joinColumn.name]: id,
          [joinTable.inverseJoinColumn.name]: destFolder.id,
        }))
      );

    await strapi.db
      .getConnection(fileTable)
      .transacting(trx)
      .whereIn('id', fileIds)
      .update(folderPathColumn, destFolder.path);
  });

  return fileIds.length;
}

async function loadFilesByFolderPath(folderPath) {
  const result = [];
  let offset = 0;
  for (;;) {
    const batch = await strapi.db.query(FILE_UID).findMany({
      where: { folderPath },
      orderBy: { id: 'asc' },
      limit: BATCH_SIZE,
      offset,
    });
    if (!batch.length) break;
    result.push(...batch);
    if (batch.length < BATCH_SIZE) break;
    offset += batch.length;
  }
  return result;
}

async function migrate() {
  const apiUploadFolder = await strapi
    .plugin('upload')
    .service('api-upload-folder')
    .getAPIUploadFolder();

  console.log(
    `[migrate] API Uploads root folder: id=${apiUploadFolder.id} path=${apiUploadFolder.path}`
  );

  // 1) 收集所有还挂在根目录（folderPath = root.path）的文件，按月份桶分组。
  const rootFiles = await loadFilesByFolderPath(apiUploadFolder.path);
  const buckets = new Map();
  for (const file of rootFiles) {
    const { year, month } = getYearMonth(file);
    const key = `${year}-${month}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { year, month, files: [] };
      buckets.set(key, bucket);
    }
    bucket.files.push(file);
  }

  console.log(
    `[migrate] root-level files to migrate: ${rootFiles.length}, buckets: ${buckets.size}`
  );

  let migrated = 0;
  const sortedKeys = [...buckets.keys()].sort();
  // 缓存月份子文件夹，供后续 repair 阶段复用。
  const monthFolderCache = new Map(); // key: "YYYY-MM" -> folder

  for (const key of sortedKeys) {
    const { year, month, files } = buckets.get(key);
    const yearFolder = await findOrCreateSubfolder(apiUploadFolder, year);
    const monthFolder = await findOrCreateSubfolder(yearFolder, month);
    monthFolderCache.set(key, monthFolder);

    console.log(
      `[migrate] ${key}: ${files.length} files -> folder.id=${monthFolder.id} path=${monthFolder.path}${monthFolder.__dry ? ' (dry)' : ''}`
    );

    if (DRY_RUN || monthFolder.__dry) {
      migrated += files.length;
      continue;
    }

    migrated += await reassignFilesToFolder(
      files.map((f) => f.id),
      monthFolder
    );
  }

  console.log(
    `[migrate] root-level migration: ${migrated}/${rootFiles.length}${DRY_RUN ? ' (dry-run)' : ''}`
  );

  // 2) 修复阶段：处理上一版仅更新了 folderPath 但未更新 join table 的"残废文件"。
  //    遍历 root 下所有已存在的年月子文件夹，按其 path 拉取 folderPath 一致的文件，
  //    再覆盖写一次 join table。即便 link 表已正确，重复 set 也只是 1 次 delete+insert，安全。
  const yearFolders = await strapi.db.query(FOLDER_UID).findMany({
    where: { parent: apiUploadFolder.id },
  });

  let repaired = 0;
  for (const yearFolder of yearFolders) {
    const monthFolders = await strapi.db.query(FOLDER_UID).findMany({
      where: { parent: yearFolder.id },
    });
    for (const monthFolder of monthFolders) {
      const files = await loadFilesByFolderPath(monthFolder.path);
      if (!files.length) continue;

      console.log(
        `[repair] ${yearFolder.name}/${monthFolder.name}: ${files.length} files re-link -> folder.id=${monthFolder.id}`
      );

      if (DRY_RUN) {
        repaired += files.length;
        continue;
      }

      repaired += await reassignFilesToFolder(
        files.map((f) => f.id),
        monthFolder
      );
    }
  }

  console.log(
    `[migrate] done. root-migrated=${migrated}, repaired-links=${repaired}${DRY_RUN ? ' (dry-run, no writes)' : ''}`
  );
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    await migrate();
  } finally {
    await app.destroy();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});

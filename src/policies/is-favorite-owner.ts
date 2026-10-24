import type { Core } from '@strapi/strapi';
const extractUserId = (value: any): number | undefined => {
  if (!value) return undefined;

  if (typeof value === 'object' && value !== null) {
    if (typeof value.id === 'number') return value.id;
    const connect = value.connect;
    if (Array.isArray(connect) && connect.length > 0) {
      if (typeof connect[0] === 'number') return connect[0];
      if (typeof connect[0]?.id === 'number') return connect[0].id;
    }
  }

  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    const asInt = Number.parseInt(value, 10);
    if (!Number.isNaN(asInt) && asInt.toString() === value) {
      return asInt;
    }
  }

  return undefined;
};

const loadFavorite = async (documentId: string, strapi: Core.Strapi) => {
  const favoriteByDocumentId = await strapi.documents('api::favorite.favorite').findOne({
    documentId,
    populate: {
      user: true,
    },
  });

  if (favoriteByDocumentId?.id) return favoriteByDocumentId;

  const asNumber = Number.parseInt(String(documentId), 10);
  if (Number.isNaN(asNumber)) return null;

  return strapi.db.query('api::favorite.favorite').findOne({
    where: { id: asNumber },
    populate: {
      user: true,
    },
  });
};

export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user?.id) return false;

  const documentId = policyContext.params?.id;
  const data = policyContext.request?.body?.data;

  if (!documentId) {
    const requestUserId = extractUserId(data?.user);
    return requestUserId === user.id;
  }

  const favorite = await loadFavorite(documentId, strapi);
  if (!favorite?.user?.id || favorite.user.id !== user.id) return false;

  if (!data?.user) return true;

  const requestUserId = extractUserId(data.user);
  return requestUserId === user.id;
};

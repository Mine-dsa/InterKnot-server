import { invalidateAgentConfigCache } from '../../../../utils/agent/resolve';

export default {
  async afterCreate() {
    invalidateAgentConfigCache();
  },
  async afterUpdate() {
    invalidateAgentConfigCache();
  },
  async afterDelete() {
    invalidateAgentConfigCache();
  },
};

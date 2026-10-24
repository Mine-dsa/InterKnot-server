/**
 * 角色 Tool Use（3.3.3）worker 侧：工具的 OpenAI function 定义。
 * 执行交由 Strapi 内部端点 /agent/internal/tool（见 strapi.ts::runAgentTool），
 * worker 只负责把角色卡启用的工具名映射为 LLM 可见的 function 规格。
 */

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOL_SPECS: Record<string, ToolSpec> = {
  search_posts: {
    type: 'function',
    function: {
      name: 'search_posts',
      description: '在绳网站内按关键词搜索已发布的帖子。返回结果中每条帖子格式为 [标题](/post/id)，这是 markdown 链接。你在回复中引用帖子时必须严格保留 [标题](/post/id) 原样格式，禁止拆开、改写或省略括号部分，否则用户无法点击。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
        },
        required: ['query'],
      },
    },
  },
  get_hot_posts: {
    type: 'function',
    function: {
      name: 'get_hot_posts',
      description: '获取当前绳网的热门帖子列表（按活跃度排序）。返回结果中每条帖子格式为 [标题](/post/id)，这是 markdown 链接。你在回复中引用帖子时必须严格保留 [标题](/post/id) 原样格式，禁止拆开、改写或省略括号部分，否则用户无法点击。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数，1-10，默认 5' },
        },
      },
    },
  },
  get_user_info: {
    type: 'function',
    function: {
      name: 'get_user_info',
      description: '按用户名查询某位绳网用户的公开信息（等级、简介）。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: '目标用户名（可不含 @）' },
        },
        required: ['username'],
      },
    },
  },
  get_post_content: {
    type: 'function',
    function: {
      name: 'get_post_content',
      description: '获取指定帖子的完整正文内容。仅在用户明确要求总结、分析或引用帖子内容时才调用此工具，不要主动调用。',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: '帖子的 document_id（从上下文中获取）' },
        },
        required: ['document_id'],
      },
    },
  },
  get_post_comments: {
    type: 'function',
    function: {
      name: 'get_post_comments',
      description: '获取指定帖子评论区的评论内容（按热度排序的顶层评论，并附带部分楼中楼回复）。当用户想了解某个帖子「评论区都说了什么」「网友怎么看」「大家的讨论/反应」时调用。匿名评论以匿名名展示。',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: '帖子的 document_id（从上下文或 search_posts / get_hot_posts 结果的 /post/<document_id> 链接中获取）' },
          limit: { type: 'integer', description: '返回的顶层评论条数，1-20，默认 10' },
        },
        required: ['document_id'],
      },
    },
  },
};

/** 把角色卡启用的工具名解析为 LLM 可见的 function 规格，过滤未知工具。 */
export function resolveToolSpecs(toolNames: unknown): ToolSpec[] {
  if (!Array.isArray(toolNames)) return [];
  const specs: ToolSpec[] = [];
  for (const name of toolNames) {
    const spec = typeof name === 'string' ? TOOL_SPECS[name] : undefined;
    if (spec) specs.push(spec);
  }
  return specs;
}

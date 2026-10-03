import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Markdown 与 raw/ 是知识内容的真源；SQLite 同时保存索引与不可从文件恢复的
 * 草稿、审阅决定、来源记录和聊天记录。只能重建索引表，不能删除整个数据库。
 */

/* -------------------------------------------------------------- 原始资料 */
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    /** raw/ 下的 vault 相对路径 */
    docPath: text("doc_path").notNull(),
    originalName: text("original_name").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    mimeType: text("mime_type"),
    title: text("title"),
    importedAt: text("imported_at").notNull(),
    /** pending | parsing | awaiting_review | parsed | failed */
    status: text("status").notNull().default("pending"),
    /** .weave/parsed/ 下的解析产物路径 */
    parsedPath: text("parsed_path"),
    pageCount: integer("page_count"),
    /** 解析器名称与版本，用于判断是否需要重新解析 */
    parser: text("parser"),
    metaJson: text("meta_json"),
  },
  (table) => [
    uniqueIndex("idx_sources_sha256").on(table.sha256),
    index("idx_sources_status").on(table.status),
  ],
);

/* ------------------------------------------------------ 待处理的导入文件 */
/** 暂存批量导入的文件；原件进入 raw/ 后会删除对应暂存文件。 */
export const ingestQueue = sqliteTable(
  "ingest_queue",
  {
    id: text("id").primaryKey(),
    originalName: text("original_name").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** queued | processing | awaiting_review | failed */
    status: text("status").notNull().default("queued"),
    jobId: text("job_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_ingest_queue_status_created").on(table.status, table.createdAt),
    index("idx_ingest_queue_job").on(table.jobId),
  ],
);

/* ------------------------------------------------------------ 词条（页面）*/
export const pages = sqliteTable(
  "pages",
  {
    /** frontmatter 里的 ULID，永不变更 —— 一致性内核的锚点 */
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    /** entity | concept | source | query | overview */
    type: text("type").notNull(),
    title: text("title").notNull(),
    /** vault 相对路径 */
    filePath: text("file_path").notNull(),
    /** 正文内容的 SHA256，用于判脏与冲突检测 */
    contentHash: text("content_hash").notNull(),
    /** frontmatter 原样 JSON，读取时无需再解析文件 */
    frontmatterJson: text("frontmatter_json").notNull(),
    /** 标题与别名的归一化形式，用于链接解析时快速命中 */
    normalizedNames: text("normalized_names").notNull(),
    /** active | deleted | conflicted（多份 Markdown 使用同一 id） */
    status: text("status").notNull().default("active"),
    deletedAt: text("deleted_at"),
    /** 合并后指向的新词条 id */
    redirectTo: text("redirect_to"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    indexedAt: text("indexed_at").notNull(),
  },
  (table) => [
    // 历史/冲突行保留原路径；只有当前活跃身份拥有该文件，不能让旧 id 占住新内容。
    uniqueIndex("idx_pages_file_path").on(table.filePath).where(sql`${table.status} = 'active'`),
    // slug 刻意不做唯一约束：vault 是唯一真源，用户可能在 Obsidian 里手工
    // 造出两个同 slug 的文件。索引器必须能容忍，并把冲突送进审阅队列，
    // 而不是让整个索引崩掉。
    index("idx_pages_slug").on(table.slug),
    index("idx_pages_type").on(table.type),
    index("idx_pages_status").on(table.status),
  ],
);

/* ------------------------------------------------------------------ 双链 */
export const links = sqliteTable(
  "links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 链接所在的词条 */
    srcPageId: text("src_page_id").notNull(),
    /** 正文里的原始写法，[[张三|老张]] 里的 "张三" */
    dstRaw: text("dst_raw").notNull(),
    /** 归一化后的目标名，用于命中 */
    dstNormalized: text("dst_normalized").notNull(),
    /** 解析到的目标词条；为 null 表示死链 */
    dstPageId: text("dst_page_id"),
    heading: text("heading"),
    alias: text("alias"),
    /** 该链接在此词条中出现的次数 */
    occurrences: integer("occurrences").notNull().default(1),
  },
  (table) => [
    index("idx_links_src").on(table.srcPageId),
    index("idx_links_dst").on(table.dstPageId),
    index("idx_links_dst_normalized").on(table.dstNormalized),
    index("idx_links_dangling").on(table.dstNormalized, table.dstPageId),
  ],
);

/* -------------------------------------------------------------- 重定向表 */
/**
 * 改名与合并都往这里写一条。它是「别名/重定向必须与 ID 同为一等公民」的落地 ——
 * 少了它，[[旧名]] 会在改名后静默变成死链。
 */
export const redirects = sqliteTable(
  "redirects",
  {
    /** 归一化后的旧名 */
    oldNormalized: text("old_normalized").primaryKey(),
    /** 旧名的原始写法，用于展示 */
    oldRaw: text("old_raw").notNull(),
    newPageId: text("new_page_id").notNull(),
    /** rename | merge */
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_redirects_new").on(table.newPageId)],
);

/* -------------------------------------------------------- 关系边（带溯源）*/
/**
 * 边必须存「为什么连」而不只是「连了」。
 * signalsJson 存相关性信号，evidencePagePath / sourceDocId 存证据来源。
 * 这支撑两个 UI：图谱上点边弹出解释卡片、词条底部「相关页面（按关联强度排序）」。
 */
export const edges = sqliteTable(
  "edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourcePageId: text("source_page_id").notNull(),
    targetPageId: text("target_page_id").notNull(),
    /** 关系类型，如 mentions | part_of | contradicts | derived_from */
    relType: text("rel_type").notNull().default("mentions"),
    /** 关联强度 0..1 */
    weight: real("weight").notNull().default(0.5),
    signalsJson: text("signals_json"),
    /** 证据所在词条 */
    evidencePagePath: text("evidence_page_path"),
    /** 证据来源文档 */
    sourceDocId: text("source_doc_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_edges_source").on(table.sourcePageId),
    index("idx_edges_target").on(table.targetPageId),
    uniqueIndex("idx_edges_unique").on(table.sourcePageId, table.targetPageId, table.relType),
  ],
);

/* ------------------------------------------------------------------ 任务 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** ingest | lint | reindex | rebuild_graph */
    kind: text("kind").notNull(),
    /** queued | running | awaiting_review | committing | discarding | done | failed | cancelled */
    status: text("status").notNull().default("queued"),
    /** 细粒度阶段：uploaded | parsing | analyzing | drafting | reviewing | committing */
    stage: text("stage").notNull().default("uploaded"),
    progress: real("progress").notNull().default(0),
    total: real("total").notNull().default(100),
    message: text("message"),
    error: text("error"),
    payloadJson: text("payload_json"),
    /** 审阅草稿：生成结果暂存在这里，用户确认后才落盘 */
    draftJson: text("draft_json"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("idx_jobs_status").on(table.status),
    index("idx_jobs_kind").on(table.kind),
  ],
);

/* ------------------------------------------------------------ 对话与消息 */
export type ChatSessionTitleOrigin = "legacy" | "fallback" | "ai" | "manual";
export type ChatSessionTitleSummaryStatus = "idle" | "pending" | "generating" | "failed";

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("新对话"),
    /** legacy | fallback | ai | manual */
    titleOrigin: text("title_origin").$type<ChatSessionTitleOrigin>().notNull().default("legacy"),
    /** idle | pending | generating | failed */
    titleSummaryStatus: text("title_summary_status").$type<ChatSessionTitleSummaryStatus>().notNull().default("idle"),
    configJson: text("config_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** 移入会话回收站的时间；null 表示正常会话 */
    deletedAt: text("deleted_at"),
  },
  (table) => [index("idx_chat_sessions_deleted").on(table.deletedAt)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    /** user | assistant */
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** 引用列表：编号、来源词条、原文片段、页码 */
    citationsJson: text("citations_json"),
    /** 检索到的上下文快照，便于事后核查引用 */
    contextJson: text("context_json"),
    /** 是否已回填为 wiki 词条 */
    filedAsPageId: text("filed_as_page_id"),
    /**
     * 生成这条回答时，请求实际消耗的输入 token 数（取自 provider 的 usage.promptTokens）。
     *
     * 存它而不是每次重算，是因为重算不出来：检索到的上下文正文没有落库
     * （contextJson 只存了词条的 id/标题/得分），而检索块恰恰是 prompt 里最大的一块。
     * 没有这一列，刷新页面后前端就只能拿「system + 摘要 + 历史」估算，
     * 显示的数字会比刚才那轮真实值小一大截，看起来像是刷新把上下文清空了。
     *
     * 可空：老数据没有，知识库为空而不调模型的那一轮也没有。
     */
    promptTokens: integer("prompt_tokens"),
    /**
     * 生成这条回答时，为了塞进窗口而**硬丢掉**的历史消息条数（通常为 0）。
     *
     * 丢掉的消息不在摘要里，是真正的信息损失，必须显示给用户。存这一列的理由与
     * promptTokens 相同：它是「那一轮发生了什么」的历史事实，事后重算不出来 ——
     * 不存，刷新页面后这句提示就消失，用户看到的只有一切正常。
     */
    droppedMessages: integer("dropped_messages").notNull().default(0),
    /**
     * 这条回答是不是被用户中途停掉的（1 = 是）。
     *
     * 停下来的那一刻已经生成的那部分**照样落库**：不落的后果是刷新之后这条回答
     * 凭空消失，只剩一个孤零零的提问 —— 用户会以为自己的问题从来没被回答过，
     * 而屏幕上明明还留着半截文字。存下来，界面上就能如实地把它标成「已停止生成」。
     *
     * 与 promptTokens / droppedMessages 同一类：这是「那一轮发生了什么」的历史事实，
     * 事后推不出来。
     */
    interrupted: integer("interrupted").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_chat_messages_session").on(table.sessionId, table.createdAt)],
);

/** 后台问答生成状态。正文定期写回 assistant 消息，刷新后可接回实时流。 */
export const chatRuns = sqliteTable(
  "chat_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    questionMessageId: text("question_message_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    /** running | done | failed | cancelled */
    status: text("status").notNull().default("running"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
    configJson: text("config_json"),
    timingsJson: text("timings_json"),
  },
  (table) => [
    index("idx_chat_runs_session_status").on(table.sessionId, table.status),
    index("idx_chat_runs_status").on(table.status),
  ],
);

/* ------------------------------------------------------------ 对话摘要 */
export const chatArtifacts = sqliteTable("chat_artifacts", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mediaType: text("media_type").notNull(),
  status: text("status").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, table => [index("idx_chat_artifacts_message").on(table.messageId)]);

/**
 * 上下文压缩的产物：一段会话历史被模型摘要后的结果。
 *
 * 为什么独立成表而不是给 chat_sessions 加列：listSessions() 是无 where 的全表读
 * （侧栏每次刷新都要跑），把可能几千字的摘要挂在那一行上，等于每次刷新都多读一大坨
 * 与侧栏无关的文本。这是可测量的代价，不是洁癖。
 *
 * 它与 chat_sessions / chat_messages 同属「本机应用状态」而不是「知识库索引」。
 * 单独一份摘要可从消息重建，但全库删除会同时清掉消息，因此必须纳入数据库备份。
 */
export const chatSummaries = sqliteTable("chat_summaries", {
  /** 一个会话只保留一份当前生效的摘要，压缩是覆盖写 */
  sessionId: text("session_id").primaryKey(),
  /**
   * 摘要正文。它是模型输出、内容源自用户提问与知识库正文，因此**进下一轮 prompt 时
   * 必须用 wrapUntrusted 包裹**（不变式 4）—— 否则一段「忽略以上指令」的对话就能
   * 绕过注入防御，因为摘要看起来像系统自己写的东西。
   */
  content: text("content").notNull(),
  /**
   * 水位线：摘要已经覆盖到这条消息为止（含）。它之后的消息逐字保留。
   *
   * 存消息 id 而不是时间戳或条数：createdAt 是秒级字符串（lib/utils.ts#localISOString
   * 没有毫秒），同一秒内插入的多条消息之间没有可靠的比较依据，用它当水位线会在
   * 「同一秒里问了两次」这种情形下漏掉或重复纳入消息。
   */
  coveredToMessageId: text("covered_to_message_id").notNull(),
  /** 已被摘要掉的消息条数，用于界面展示「已压缩多少轮」 */
  coveredMessageCount: integer("covered_message_count").notNull().default(0),
  /**
   * 压缩次数。摘要是「上一版摘要 + 新一段原文」合并出来的，所以这个数字等于
   * 摘要链的层数。它只增不减，用来在排查时判断信息衰减到了第几层。
   */
  compressionCount: integer("compression_count").notNull().default(0),
  /** 摘要自身的 token 估算，供界面展示「摘要占了多少」 */
  tokenCount: integer("token_count").notNull().default(0),
  /** 生成摘要用的模型名，便于事后核查是哪次调用写坏的 */
  model: text("model"),
  /** legacy 摘要可能混入半截回答；complete 表示仅使用完整助手历史生成。 */
  historyPolicy: text("history_policy").notNull().default("legacy"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/* -------------------------------------------------------------------- 设置 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/* ---------------------------------------------------------------- 审阅队列 */
/**
 * LLM 只提议、不自主执行。矛盾、重复、缺页、过时论断、孤儿页都进这里等人判断。
 * 这是 LLM Wiki 理念里 review queue 的落地，也是「错误会静默复利」的对策。
 */
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    /** contradiction | duplicate | missing_page | stale_claim | orphan | broken_link | research */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    /** info | warning | critical */
    severity: text("severity").notNull().default("info"),
    /**
     * 这条发现涉及哪些词条，JSON 形如 [{ id, title }]。
     *
     * 为什么 id 与标题都要存，而不是二选一：
     *   - 「缺页」类发现的目标词条**尚不存在**（某个名字被引用了 3 次但还没有词条），
     *     它只有名字、没有 id —— 只存 id 会让这类发现整条渲染成空白。
     *   - 「矛盾」「重复」指向的是已有词条，有 id 才能点进去 ——
     *     只存标题的话，词条一改名，这条历史发现就指向一个不存在的名字。
     * 所以 id 为 null 表达的是「这个词条现在还不存在」，不是数据缺失。
     */
    relatedPagesJson: text("related_pages"),
    /**
     * 人的裁决：pending（待裁决）| accepted（采纳）| dismissed（忽略）。
     *
     * 这里存的是**人的判断**，与 title/detail 的来源完全不同。所以不变式 4
     * （模型输出一律当作不可信输入）不适用于它 —— 但它同样不能反过来被模型改写。
     * 回灌给模型时，它是我们自己的数据，不需要 wrapUntrusted 包裹；
     * 而 detail 需要。这就是为什么两者必须是不同的列。
     */
    status: text("status").notNull().default("pending"),
    /**
     * 用户裁决时写的一句话说明，例如「以研发同事的说法为准」。
     *
     * 单独一列而不是并进 detail：detail 是模型写的，回灌给下一轮时属于不可信内容、
     * 必须 wrapUntrusted 包裹；这一列是用户亲自写的判断。混在一起就没法分别对待。
     */
    decisionNote: text("decision_note"),
    /** 处理建议的动作，如 create_page / merge / edit */
    suggestedAction: text("suggested_action"),
    /**
     * 「让模型按批注去修」这条路的执行记录，JSON：
     *   { summary, edits: [{ pageId, title, reason }], created: [{ id, title }], provider }
     *
     * 为什么必须落库而不是只留在任务里：任务的重放缓存最多留 200 条事件、
     * 进程一重启就没了；而「这条事项是怎么被处理的」是知识库的历史事实，
     * 半年后回看这条裁决时还要能读到当时改了什么。
     */
    remediationJson: text("remediation"),
    /** 那次修改对应的 git 提交。版本页据此回滚 —— 这就是「直接改」的退路。 */
    appliedSha: text("applied_sha"),
    /**
     * 系统向用户提的那个问题，以及 2-4 个候选答案（JSON: [{ id, label, impact }]）。
     *
     * 为什么问题与回答必须分开两列：question/options 是**模型产出**，属于不可信
     * 输入，回灌进 prompt 时必须 wrapUntrusted 包裹；answer 是**用户动作的产物**，
     * 与 decision_note 同级 —— 它是用户亲手点的那个选项。混在一起就没法分别对待，
     * 与 decision_note 当初从 detail 里分出来是同一条理由。
     *
     * 为空 = 这条事项没有值得用户拍板的问题（模型给不出有区分度的选项），界面退回
     * 旧的「采纳 / 忽略 / 写批注」交互。历史行全部为空，不需要回填。
     */
    question: text("question"),
    optionsJson: text("options"),
    /**
     * 用户的答复：选中选项的 label，或他自由输入的那段话。
     *
     * 它是**回答**（一种待处理的判断），不是**裁决**（accepted/dismissed）——
     * 回答之后还要由模型去处理，处理完才成为 accepted。所以回答不直接进
     * recentDecisions 的回灌，而是在处理完成时被写进 decision_note，与
     * remediate 把批注写进 decision_note 的做法一致。
     */
    answer: text("answer"),
    /**
     * 选中的选项 id；null 表示自由输入。
     *
     * 存 id 而不是只存 label：选项措辞可能重复或事后被改动，id 才是「用户到底点了
     * 哪一个」的唯一凭据 —— 处理时模型要据此知道用户选的是哪条路径。
     */
    answerChoiceId: text("answer_choice_id"),
    /** option | freeform | null。决定界面怎么回显，也决定回灌时的来源说明 */
    answerSource: text("answer_source"),
    answeredAt: text("answered_at"),
    /**
     * 正在处理这批回答的任务 id。
     *
     * 一列承担三件事：① 同一条事项不会被两个批量任务同时认领（第二个直接被拒）；
     * ② 界面据此显示「处理中」并订阅那条 SSE；③ 刷新页面后能认领回来。
     * 任务结束（成功/失败/取消）时清空。
     *
     * 刻意不再加一个 processing 状态：它能从「status=answered 且 batch_id 指向
     * 未结束的任务」推出来，而多一个持久状态就多一份「进程被杀之后谁来回收」的
     * 负担（markInterruptedAsFailed() 只扫 running/queued）。
     */
    batchId: text("batch_id"),
    createdAt: text("created_at").notNull(),
    /** 裁决时间。沿用旧列名，语义就是「这条事项被裁定的时刻」 */
    resolvedAt: text("resolved_at"),
  },
  (table) => [index("idx_review_status").on(table.status, table.kind)],
);

/* --------------------------------------------------------------- 索引元数据 */
/** 记录索引的构建参数，用于判断是否需要全量重建 */
export const indexMeta = sqliteTable("index_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type SourceRow = typeof sources.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
export type LinkRow = typeof links.$inferSelect;
export type RedirectRow = typeof redirects.$inferSelect;
export type EdgeRow = typeof edges.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatRunRow = typeof chatRuns.$inferSelect;
export type ChatSummaryRow = typeof chatSummaries.$inferSelect;
export type ReviewItemRow = typeof reviewItems.$inferSelect;

/**
 * 审阅事项涉及的一个词条引用。
 *
 * id 为 null = 这个词条尚不存在（「缺页」类发现的目标还没被建出来）。
 * 别把它当成脏数据过滤掉 —— 那恰好是最值得用户看一眼的一类发现。
 */
export type ReviewRelatedPage = { id: string | null; title: string };

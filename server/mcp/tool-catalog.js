export const TOOLS = [
  {
    name: 'list_api_profiles',
    description: '列出 Hippocove 当前可用的 API 方案，并返回本地快检模式。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'get_portable_warm_bundle_contract',
    description: '读取公开 Driftstone portable_warm_bundle 合同、Notion 投影边界和禁止写入的私有冷树字段；只读，不触碰用户素材。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'get_growth_context',
    description: '读取给记忆卡生长用的上下文包：人格工位状态、Persona 原料概览、memory home，以及可选的 memory context。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        query: { type: 'string' },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        user_id: { type: 'string' },
        char_id: { type: 'string' },
        include_persona_rows: { type: 'boolean' },
        row_limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'build_growth_task',
    description: '生成一张可直接交给 agent 的卡片生长工单，包含当前 family、候选旧卡、最近生长日志和提交合同。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        query: { type: 'string' },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        user_id: { type: 'string' },
        char_id: { type: 'string' },
        family_id: { type: 'string' },
        card_type: { type: 'string' },
        packet_id: { type: 'string' },
        include_persona_rows: { type: 'boolean' },
        row_limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'generate_growth_draft',
    description: '基于 growth task 直接生成一份卡片生长草稿；默认只出草稿不落库，也可带 commit=true 一步记账。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        query: { type: 'string' },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        user_id: { type: 'string' },
        char_id: { type: 'string' },
        family_id: { type: 'string' },
        card_type: { type: 'string' },
        packet_id: { type: 'string' },
        include_persona_rows: { type: 'boolean' },
        row_limit: { type: 'number' },
        api_profile_name: { type: 'string' },
        mode: { type: 'string' },
        commit: { type: 'boolean' },
        export_to_obsidian: { type: 'boolean' },
        export_root: { type: 'string' },
        overwrite_export: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_growth_drafts',
    description: '列出当前 scope 最近生成的卡片草稿，方便 agent 回看自己刚刚写过什么。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        card_type: { type: 'string' },
        limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_growth_draft',
    description: '按 artifact_id 读取一张具体的卡片草稿，包括 markdown 与 JSON 归档。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        card_type: { type: 'string' },
        artifact_id: { type: 'string' }
      },
      required: ['owner_id', 'realm_id', 'artifact_id'],
      additionalProperties: false
    }
  },
  {
    name: 'export_growth_draft_to_obsidian',
    description: '把一张已生成的卡片草稿导出到 Obsidian staging 目录；默认建议先导到 /tmp 做烟雾检查。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        card_type: { type: 'string' },
        artifact_id: { type: 'string' },
        root_dir: { type: 'string' },
        overwrite: { type: 'boolean' }
      },
      required: ['owner_id', 'realm_id', 'artifact_id'],
      additionalProperties: false
    }
  },
  {
    name: 'get_card_registry',
    description: '读取当前 scope 的卡片目录摘要，方便 agent 知道已经写过哪些卡、每类卡有多少张。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'upsert_card_registry_entry',
    description: '写入或更新一条卡片目录记录，让后续生长知道这张卡已经存在、最近做过什么动作。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        entry: { type: 'object' }
      },
      required: ['owner_id', 'realm_id', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'get_growth_ledger',
    description: '读取当前 scope 的生长日志，查看最近 new/update/merge/skip 的判断脉络。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'append_growth_ledger_entry',
    description: '追加一条生长决策日志，记住这轮为什么新建、补写、合并或跳过。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        entry: { type: 'object' }
      },
      required: ['owner_id', 'realm_id', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'commit_growth_decision',
    description: '一次提交同时更新卡片目录与生长日志，适合 agent 在判完 new/update/merge/skip 之后落账。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        decision: { type: 'string' },
        packet_id: { type: 'string' },
        reason: { type: 'string' },
        next_hint: { type: 'string' },
        actor: { type: 'string' },
        source: { type: 'string' },
        card_entry: { type: 'object' },
        ledger_entry: { type: 'object' }
      },
      required: ['owner_id', 'realm_id', 'decision'],
      additionalProperties: false
    }
  },
  {
    name: 'get_persona_workspace_state',
    description: '读取当前人格工位状态，包括 char/user、soul、语言指纹、候选池，以及 Persona 缓存概览。',
    inputSchema: {
      type: 'object',
      properties: {
        include_persona_rows: { type: 'boolean' },
        row_limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'save_persona_workspace_state',
    description: '保存当前人格工位状态，让前台与 agent 共用同一份 char/user、soul 与语言指纹。',
    inputSchema: {
      type: 'object',
      properties: {
        char_name: { type: 'string' },
        user_name: { type: 'string' },
        persona_card: { type: 'string' },
        language_fingerprint: { type: 'string' },
        fingerprint_candidate_pool: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'build_language_fingerprint_candidates',
    description: '从当前 Persona 缓存整理语言指纹候选池；可选择是否写回人格工位状态。',
    inputSchema: {
      type: 'object',
      properties: {
        save: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'generate_soul_draft',
    description: '基于当前 Persona 缓存与当前 API 方案，生成 soul 草稿；可选择是否写回人格工位状态。',
    inputSchema: {
      type: 'object',
      properties: {
        api_profile_name: { type: 'string' },
        save: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'generate_language_fingerprint',
    description: '基于候选池、当前 Persona 缓存与当前 API 方案，生成语言指纹；可选择是否写回人格工位状态。',
    inputSchema: {
      type: 'object',
      properties: {
        api_profile_name: { type: 'string' },
        save: { type: 'boolean' },
        candidate_pool: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'run_history_pipeline',
    description: '把一个或多个历史记录文件送进 Hippocove 流水线，完成入包、分片、提炼、reviewed 去重和最终写回。',
    inputSchema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要处理的本地文件绝对路径；支持多文件一起送入。'
        },
        mode: {
          type: 'string',
          description: 'local_programmatic 表示本地快检，不走外部 API；api_profile 表示使用已保存 API 方案。'
        },
        api_profile_name: {
          type: 'string',
          description: '当 mode=api_profile 时可指定方案名；不填则默认读取当前配置。'
        },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        target_chars: { type: 'number' },
        max_slices: { type: 'number' },
        max_chars: { type: 'number' },
        entry_limit: { type: 'number' }
      },
      required: ['file_paths'],
      additionalProperties: false
    }
  },
  {
    name: 'prepare_history_source',
    description: '只做原始记录入包、按时间拼装、分片和批任务准备，不代替 AI 推进后续提炼。',
    inputSchema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' }
        },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        target_chars: { type: 'number' },
        max_slices: { type: 'number' },
        max_chars: { type: 'number' },
        entry_limit: { type: 'number' }
      },
      required: ['file_paths'],
      additionalProperties: false
    }
  },
  {
    name: 'pull_translation_task',
    description: '取出下一条待处理的提炼任务包，让远端 AI 自己读 contract、自己产出 entries。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        task_file: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'submit_translation_entries',
    description: '把远端 AI 产出的 entries 或 raw_output 写回 reviewed，并自动推进任务状态。',
    inputSchema: {
      type: 'object',
      properties: {
        task_file: { type: 'string' },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        source_label: { type: 'string' },
        raw_output: { type: 'string' },
        entries: {
          type: 'array',
          items: { type: 'object' }
        }
      },
      required: ['task_file'],
      additionalProperties: false
    }
  },
  {
    name: 'fail_translation_task',
    description: '当远端 AI 判断当前任务无法安全提炼时，显式标记失败并写回原因。',
    inputSchema: {
      type: 'object',
      properties: {
        task_file: { type: 'string' },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        source_label: { type: 'string' },
        error: { type: 'string' },
        raw_output: { type: 'string' }
      },
      required: ['task_file'],
      additionalProperties: false
    }
  },
  {
    name: 'list_reviewed_clusters',
    description: '列出 reviewed 层的 cluster，方便远端 AI 判断哪些需要进一步语义合并。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' }
      },
      required: ['owner_id', 'realm_id'],
      additionalProperties: false
    }
  },
  {
    name: 'finalize_reviewed_entries',
    description: '把 reviewed cluster 最终写回 roots/vines；可附带 AI 合并后的 ai_merges。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        ai_merges: {
          type: 'array',
          items: { type: 'object' }
        }
      },
      required: ['owner_id', 'realm_id'],
      additionalProperties: false
    }
  },
  {
    name: 'inspect_pipeline_scope',
    description: '查看某个 scope 当前已经落下来的 ingest / translation / tasks / reviewed 状态。',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' }
      },
      required: ['owner_id', 'realm_id'],
      additionalProperties: false
    }
  },
  {
    name: 'get_memory_context',
    description: '按 mcp 模式读取紧凑 memory context packet，方便 agent 在不重翻全库的情况下取上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        query: { type: 'string' },
        owner_id: { type: 'string' },
        realm_id: { type: 'string' },
        bot_id: { type: 'string' },
        mode: { type: 'string' }
      },
      additionalProperties: false
    }
  }
];

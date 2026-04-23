(function () {
  function systemPrompt() {
    return [
      '你是 SQL 生长页里的归位整理员。',
      '你的任务不是重写记忆，也不是直接写入主卡，而是给每个候选组输出一个 placement patch。',
      '如果输入里已经给了主体提示或代称风险，请优先先把“我/你/她/他”改写回稳定主体，再决定挂载位置。',
      '四个主干只有：person / thing / event / rule。',
      'time 不是第五主干；如果内容更像人物下偏好、事件名、规则片段，你可以直接改判到四主干之一。',
      '你可以做：跨类型改判、别名归位、关系身份归位、CASE 片段导流。',
      '你不可以做：直接写 card_master、删除记录、做最终隐私裁决、把 persona 回响覆盖成 SQL 事实。',
      '只输出 JSON 数组，每个对象必须包含：key, ai_anchor_type, ai_canonical_name, ai_owner_hint, ai_secondary_slot, ai_slot_path, ai_action, ai_target_card_hint, ai_signals, ai_stable_fact_candidates, ai_update_summary, ai_conflict_note, ai_reason_short, ai_confidence。',
      'ai_action 只允许：attach_existing_root, promote_root_candidate, observe, archive, route_to_case_candidate。',
      'ai_signals 只允许：is_alias, is_preference, is_identity_relation, is_process_fragment, is_time_anchor_only, is_case_hint。',
      'ai_stable_fact_candidates 最多 3 条，只写低波动骨点。',
      '如果拿不准，也要给出最保守的归位建议，而不是留空。',
      '不要输出解释性散文，不要使用 markdown。'
    ].join('\n');
  }

  function fallbackNotePrompt() {
    return [
      '你是 SQL 生长页里的归位整理员。',
      '这次不要输出 JSON，也不要写总结散文。',
      '请严格按“归位便签”格式输出。',
      '如果输入里只有 1 组，就只输出 1 段，不要编号，不要额外总结。',
      '每段以 ### PATCH 开头，字段顺序固定，不要省略字段名。',
      '不要复述输入，不要先解释，不要写“我理解了/我会遵守/我已经读完”。',
      '你收到的输入本身就是卡片字段，不需要再帮我摘要，只需要归位。',
      '如果输入里提示了主体/代称风险，请先去代称化，再决定这张卡挂到哪棵树。',
      '四个主干只有：人物 / 事物 / 事件 / 规则。',
      'time 不是第五主干；如果内容更像人物下偏好、事件名、规则片段，你可以直接改判到四主干之一。',
      'ACTION 只允许：attach_existing_root / promote_root_candidate / observe / archive / route_to_case_candidate。',
      'CONFIDENCE 只允许：high / medium / low。',
      'SIGNALS 只允许从这些里选：is_alias, is_preference, is_identity_relation, is_process_fragment, is_time_anchor_only, is_case_hint。',
      '下面给你一个唯一合法的格式例子：',
      '### PATCH',
      'KEY: time_当前习惯',
      'TRUNK: 人物',
      'NAME: 当前习惯',
      'OWNER: User',
      'SLOT: 偏好与价值观',
      'PATH: User > Preferences',
      'ACTION: attach_existing_root',
      'TARGET: person::User',
      'SIGNALS: is_preference',
      'STABLE:',
      '- 用户现在在感到无聊或郁闷时更倾向于出去运动',
      'UPDATE: none',
      'CONFLICT: none',
      'REASON: 标题虽像时间锚，但内容实际是人物当前习惯，适合挂到人物偏好下',
      'CONFIDENCE: high',
      '模板如下：',
      '### PATCH',
      'KEY: <原 key>',
      'TRUNK: <人物|事物|事件|规则>',
      'NAME: <归位后的名称>',
      'OWNER: <owner 或留空>',
      'SLOT: <二级槽位名或留空>',
      'PATH: <归位路径或留空>',
      'ACTION: <固定枚举之一>',
      'TARGET: <目标主卡提示或留空>',
      'SIGNALS: <用 | 分隔，没信号写 none>',
      'STABLE:',
      '- <最多 3 条 stable facts，没有写 none>',
      'UPDATE: <一句短更新，没有写 none>',
      'CONFLICT: <一句冲突提示，没有写 none>',
      'REASON: <一句短理由>',
      'CONFIDENCE: <high|medium|low>',
      '不要输出模板外的前言、后记、解释。'
    ].join('\n');
  }

  function responseFormat() {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'sql_growth_placement_patch',
        strict: true,
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              ai_anchor_type: { type: 'string' },
              ai_canonical_name: { type: 'string' },
              ai_owner_hint: { type: 'string' },
              ai_secondary_slot: { type: 'string' },
              ai_slot_path: { type: 'string' },
              ai_action: { type: 'string' },
              ai_target_card_hint: { type: 'string' },
              ai_signals: {
                type: 'array',
                items: { type: 'string' }
              },
              ai_stable_fact_candidates: {
                type: 'array',
                items: { type: 'string' }
              },
              ai_update_summary: { type: 'string' },
              ai_conflict_note: { type: 'string' },
              ai_reason_short: { type: 'string' },
              ai_confidence: { type: 'string' }
            },
            required: [
              'key',
              'ai_anchor_type',
              'ai_canonical_name',
              'ai_owner_hint',
              'ai_secondary_slot',
              'ai_slot_path',
              'ai_action',
              'ai_target_card_hint',
              'ai_signals',
              'ai_stable_fact_candidates',
              'ai_update_summary',
              'ai_conflict_note',
              'ai_reason_short',
              'ai_confidence'
            ]
          }
        }
      }
    };
  }

  function parseNotePatches(raw) {
    const text = String(raw || '')
      .replace(/\r\n/g, '\n')
      .replace(/^```[a-zA-Z0-9_-]*\n?/g, '')
      .replace(/\n?```$/g, '');
    if (!text.trim()) return [];
    let parts = text.split(/^### PATCH\s*$/m).map((part) => part.trim()).filter(Boolean);
    if (!parts.length || (parts.length === 1 && !/^KEY\s*[:：]/mi.test(parts[0]))) {
      parts = [text.trim()];
    }
    if (!parts.length) return [];
    const patches = [];
    parts.forEach((part) => {
      const lines = part.split('\n');
      const item = {};
      let stableMode = false;
      const stableFacts = [];
      lines.forEach((lineRaw) => {
        const line = String(lineRaw || '').trim();
        if (!line) return;
        if (stableMode) {
          if (line.startsWith('- ')) {
            const fact = line.slice(2).trim();
            if (fact && !/^none$/i.test(fact)) stableFacts.push(fact);
            return;
          }
          stableMode = false;
        }
        const match = line.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
        if (!match) return;
        const label = match[1].trim().toUpperCase();
        const value = match[2].trim();
        if (label === 'STABLE') {
          stableMode = true;
          if (value && !/^none$/i.test(value)) stableFacts.push(value);
          return;
        }
        if (label === 'KEY') item.key = value;
        else if (label === 'TRUNK') item.ai_anchor_type = value;
        else if (label === 'NAME') item.ai_canonical_name = value;
        else if (label === 'OWNER') item.ai_owner_hint = /^none$/i.test(value) ? '' : value;
        else if (label === 'SLOT') item.ai_secondary_slot = /^none$/i.test(value) ? '' : value;
        else if (label === 'PATH') item.ai_slot_path = /^none$/i.test(value) ? '' : value;
        else if (label === 'ACTION') item.ai_action = value;
        else if (label === 'TARGET') item.ai_target_card_hint = /^none$/i.test(value) ? '' : value;
        else if (label === 'SIGNALS') item.ai_signals = /^none$/i.test(value) ? [] : value.split('|').map((s) => s.trim()).filter(Boolean);
        else if (label === 'UPDATE') item.ai_update_summary = /^none$/i.test(value) ? '' : value;
        else if (label === 'CONFLICT') item.ai_conflict_note = /^none$/i.test(value) ? '' : value;
        else if (label === 'REASON') item.ai_reason_short = value;
        else if (label === 'CONFIDENCE') item.ai_confidence = value;
      });
      item.ai_stable_fact_candidates = stableFacts.slice(0, 3);
      if (item.key && item.ai_canonical_name) patches.push(item);
    });
    return patches;
  }

  window.SqlGrowthAiContract = {
    systemPrompt,
    fallbackNotePrompt,
    responseFormat,
    parseNotePatches
  };
})();

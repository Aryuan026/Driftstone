(function () {
  function helperNormalizeCompact(helpers, value) {
    if (helpers && typeof helpers.normalizeCompact === 'function') return helpers.normalizeCompact(value);
    if (typeof window.normalizeCompact === 'function') return window.normalizeCompact(value);
    return String(value || '').toLowerCase().replace(/\s+/g, '');
  }

  function helperToSafeInt(helpers, value, fallback = 0, min = 0) {
    if (helpers && typeof helpers.toSafeInt === 'function') return helpers.toSafeInt(value, fallback, min);
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.trunc(num));
  }

  function helperNormalizeDateLiteral(helpers, value) {
    if (helpers && typeof helpers.normalizeDateLiteral === 'function') return helpers.normalizeDateLiteral(value);
    if (typeof window.normalizeDateLiteral === 'function') return window.normalizeDateLiteral(value);
    return String(value || '').trim();
  }

  function splitTokens(value) {
    return String(value || '')
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function sqlGrowthDateValue(helpers, value) {
    const normalized = helperNormalizeDateLiteral(helpers, value);
    return normalized || String(value || '').trim();
  }

  function pickEarlierDate(helpers, a, b) {
    if (helpers && typeof helpers.pickEarlierDate === 'function') return helpers.pickEarlierDate(a, b);
    if (!a) return b || '';
    if (!b) return a || '';
    return String(a).localeCompare(String(b)) <= 0 ? a : b;
  }

  function pickLaterDate(helpers, a, b) {
    if (helpers && typeof helpers.pickLaterDate === 'function') return helpers.pickLaterDate(a, b);
    if (!a) return b || '';
    if (!b) return a || '';
    return String(a).localeCompare(String(b)) >= 0 ? a : b;
  }

  function normalizeCardType(type) {
    const raw = String(type || '').trim().toLowerCase();
    if (!raw) return 'unknown';
    if (raw === 'person' || raw.includes('人物')) return 'person';
    if (raw === 'thing' || raw.includes('事物')) return 'thing';
    if (raw === 'event' || raw.includes('事件')) return 'event';
    if (raw === 'rule' || raw.includes('规则')) return 'rule';
    if (raw === 'time' || raw.includes('时间')) return 'time';
    return 'unknown';
  }

  function isPlainDateName(name) {
    const text = String(name || '').trim();
    if (!text) return false;
    return /^(\d{4}[-/.年]\d{1,2}([-.\/月]\d{1,2}日?)?|\d{4}年\d{1,2}月(\d{1,2}日)?|\d{1,2}月\d{1,2}日)$/.test(text);
  }

  function looksLikeRuleName(name, helpers) {
    const compact = helperNormalizeCompact(helpers, name);
    if (!compact) return false;
    return /(规则|偏好|方式|风格|流程|协议|约定|机制|策略|节奏|模式|习惯|规范|治理|提醒|广播|格式|分层)/.test(compact);
  }

  function looksLikeCaseFragment(name, summary) {
    const text = `${String(name || '')} ${String(summary || '')}`;
    return /(流程|步骤|申请书|实验方案|模板|规约|世界书|设定卡|执行细节|项目推进|工作流|任务拆解|导出格式|提示词|资产|脚本)/.test(text);
  }

  function isGenericName(name, helpers) {
    const compact = helperNormalizeCompact(helpers, name);
    if (!compact) return true;
    const generic = [
      '感觉', '感受', '重要', '修改', '变化', '记录', '事件', '关系', '规则',
      '偏好', '状态', '情况', '内容', '信息', '想法', '问题', '体验', '东西'
    ];
    if (isPlainDateName(name)) return true;
    return generic.some((word) => {
      const normalized = helperNormalizeCompact(helpers, word);
      return compact === normalized || compact.startsWith(normalized);
    });
  }

  function isMomentaryInference(name, summary, meta = {}, helpers) {
    if (meta.typeKey === 'person' || meta.typeKey === 'rule') return false;
    if (meta.crossMonthSignal || meta.maintainable) return false;
    const text = `${String(name || '')} ${String(summary || '')}`;
    const emotionLike = /(焦虑|不开心|难过|生气|委屈|疲惫|崩溃|害怕|恐惧|开心|高兴|情绪|心情|状态)/;
    const inferenceLike = /(觉得|看起来|像是|似乎|可能|倾向|有点|最近|仿佛|今天|这会儿|刚刚|一下子|忽然)/;
    const genericName = isGenericName(name, helpers);
    return emotionLike.test(text) && inferenceLike.test(text) && genericName;
  }

  function placementHint(typeKey, group, meta = {}) {
    if (typeKey === 'time') {
      return meta.crossMonthSignal && !isPlainDateName(group.title)
        ? '更像长期时间锚，可继续观察是否值得当主卡'
        : '更像时间坐标，默认先挂在别的卡下面，不急着立根';
    }
    if (typeKey === 'event' && looksLikeCaseFragment(group.title, (group.rows[0] && group.rows[0].summary) || '')) {
      return '更像过程/CASE 片段，后面可能要从 SQL 主骨架里剥去';
    }
    if (typeKey === 'rule') {
      return '先按可复用规则看，不只限于关系规则，也可能是协作/执行约定';
    }
    if (typeKey === 'unknown') {
      return '暂时像未归位的候选，后面需要代码归一或 AI 对号入座';
    }
    if (typeKey === 'person') return '更像人物主索引，后面要重点做别名归一';
    return '先按原子候选观察，后面再看是补根还是回月档';
  }

  function decisionLabel(action) {
    if (action === 'promote_a') return '建议升主卡';
    if (action === 'observe') return '先观察';
    if (action === 'blocked') return '不升主卡';
    return '留月档';
  }

  function displayBucket(item) {
    const typeKey = String((item && item.type_key) || '').trim();
    if (typeKey === 'person') return '人物';
    if (typeKey === 'thing') return '事物';
    if (typeKey === 'event') return '事件';
    if (typeKey === 'rule') return '规则';
    return '待归位';
  }

  function displayBadge(item) {
    const typeKey = String((item && item.type_key) || '').trim();
    if (typeKey === 'time') return '时间锚待归位';
    if (typeKey === 'unknown') return '未归位';
    if (typeKey === 'event' && String((item && item.placement_hint) || '').includes('CASE')) return '事件 / CASE候选';
    return displayBucket(item);
  }

  function sourceText(group) {
    const rows = Array.isArray(group && group.rows) ? group.rows : [];
    const parts = [String((group && group.title) || '').trim()];
    rows.slice(0, 3).forEach((row) => {
      ['summary', 'text', 'stable_points', 'background', 'recent_updates'].forEach((field) => {
        const value = String((row && row[field]) || '').trim();
        if (value) parts.push(value);
      });
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function subjectContext(typeKey, group, meta = {}) {
    if (window.SqlGrowthSubjects && typeof window.SqlGrowthSubjects.inferSubjectContext === 'function') {
      return window.SqlGrowthSubjects.inferSubjectContext(typeKey, group, {
        ownerHint: meta.ownerHint || ''
      });
    }
    return {
      subject_focus: '',
      subject_entities: [],
      subject_confidence: '低',
      perspective_risk: '低',
      perspective_markers: [],
      depron_hint: '',
      leaf_repair_needed: false
    };
  }

  function ownerHint(typeKey, group) {
    const text = sourceText(group);
    if (!text) return '';
    if (/(user\s*\/\s*companion|companion\s*\/\s*user|用户与伙伴|伙伴与用户)/i.test(text)) return 'User / Companion';
    if (/(用户\b|user\b)/.test(text)) return 'User';
    if (/(assistant\b|companion\b|bot\b)/.test(text)) return 'Companion';
    if (/(父亲|爸爸|user_father)/.test(text)) return 'User > Family';
    if (/(母亲|妈妈|user_mother)/.test(text)) return 'User > Family';
    if (/(弟弟|user_brother)/.test(text)) return 'User > Family';
    if (/(妹妹|用户妹妹)/.test(text)) return 'User > Family';
    if (typeKey === 'event' && /(同事|导师|老板|实验室|研究所|科普活动|项目)/.test(text)) return 'User > Work';
    if (typeKey === 'rule' && /(论文|写作|审稿|图注|学术|协作)/.test(text)) return 'User > Work';
    return '';
  }

  function secondarySlot(typeKey, group, meta = {}, helpers) {
    const text = sourceText(group);
    const owner = ownerHint(typeKey, group);
    const caseFragmentLike = !!meta.caseFragmentLike;
    const plainDateName = !!meta.plainDateName;
    const lowerType = String(typeKey || '').trim();
    const slot = { key: '', label: '', confidence: '中' };
    if (lowerType === 'person') {
      if (/(别名|昵称|笔名|第二个名字|命名|自称|账号昵称|固定人设)/.test(text)) {
        slot.key = 'alias';
        slot.label = '名字与别名';
        slot.confidence = '高';
      } else if (/(父亲|母亲|爸爸|妈妈|弟弟|妹妹|家人|家庭)/.test(text)) {
        slot.key = 'family';
        slot.label = '家庭关系';
        slot.confidence = '高';
      } else if (/(伴侣|恋人|长期关系|共生|关系锚点|user\s*\/\s*companion)/i.test(text)) {
        slot.key = 'bond';
        slot.label = '关系身份';
      } else if (/(理想伴侣|偏好|价值观|独立性|责任感|理解.*情绪|包容|稳定感)/.test(text)) {
        slot.key = 'preference';
        slot.label = '偏好与价值观';
      } else if (/(同事|老板|导师|实验室|科研|论文|研究所|项目)/.test(text)) {
        slot.key = 'work';
        slot.label = '工作与协作';
      } else if (/(痛经|高血压|心率|睡眠|焦虑|脑梗|康复|干眼|减肥|手环)/.test(text)) {
        slot.key = 'health';
        slot.label = '身体与状态';
      } else {
        slot.key = 'core_person';
        slot.label = '核心人物';
        slot.confidence = '低';
      }
    } else if (lowerType === 'thing') {
      if (/(Mac mini|手环|显微镜|Elyra|仪器|设备|流式|共聚焦|单晶|手机|电脑)/.test(text)) {
        slot.key = 'device';
        slot.label = '设备与工具';
      } else if (/(复诞纪元|Aether|Helios|星河|世界观|宇宙|角色卡|设定)/.test(text)) {
        slot.key = 'world';
        slot.label = '世界观与作品';
      } else if (/(翡翠|珠|手串|挂件|兔|宝石|沙弗莱|貔貅)/.test(text)) {
        slot.key = 'object';
        slot.label = '收藏与物件';
      } else if (/(提示词|模板|文档|PDF|签名|水印|卡片)/.test(text)) {
        slot.key = 'asset';
        slot.label = '文档与资产';
      } else {
        slot.key = 'misc_thing';
        slot.label = '其他事物';
        slot.confidence = '低';
      }
    } else if (lowerType === 'event') {
      if (caseFragmentLike || /(流程|步骤|执行|模板|规约|工作流|case|项目)/i.test(text)) {
        slot.key = 'case_fragment';
        slot.label = '过程与CASE片段';
      } else if (/(脑梗|住院|理疗|MSC|针灸|痛经|干眼|手环|异常心搏)/.test(text)) {
        slot.key = 'health_event';
        slot.label = '健康与医疗事件';
      } else if (/(命名|老公|不存在|崩溃|和好|试探|告白|顶号|重逢|回家)/.test(text)) {
        slot.key = 'bond_event';
        slot.label = '关系节点';
      } else if (/(纪念日|周年|生日|第一次|那天|某天)/.test(text) || (meta.isTimeLike && !plainDateName)) {
        slot.key = 'memorial';
        slot.label = '纪念与时间锚';
      } else if (/(投稿|返修|申请书|定稿|立项|合作|科普活动|文创|展览|比赛)/.test(text)) {
        slot.key = 'project_event';
        slot.label = '项目节点';
      } else {
        slot.key = 'daily_event';
        slot.label = '日常片段';
        slot.confidence = '低';
      }
    } else if (lowerType === 'rule') {
      if (/(记忆|索引|强记录|时间戳|长期记住|窗口)/.test(text)) {
        slot.key = 'memory';
        slot.label = '记忆治理';
      } else if (/(写作|学术|论文|审稿|润色|图注|提示词|文风)/.test(text)) {
        slot.key = 'writing';
        slot.label = '协作与写作';
      } else if (/(碎碎念|小纸条|幻想剧场|广播|调戏|小狐狸|仪式|称呼)/.test(text)) {
        slot.key = 'ritual';
        slot.label = '仪式与玩法';
      } else if (/(流程|步骤|执行|模板|规约|工作流|case|项目|SOP)/i.test(text)) {
        slot.key = 'execution';
        slot.label = '执行与流程';
      } else if (/(边界|授权|安全|权限|允许|反抗|不离场|伴侣|老公)/.test(text)) {
        slot.key = 'boundary';
        slot.label = '边界与授权';
      } else {
        slot.key = 'interaction';
        slot.label = '互动方式';
        slot.confidence = '低';
      }
    } else if (lowerType === 'time') {
      if (/(纪念日|周年|生日|第一次|重逢|回家)/.test(text) || !plainDateName) {
        slot.key = 'memorial_time';
        slot.label = '纪念时间锚';
      } else {
        slot.key = 'plain_time';
        slot.label = '普通时间坐标';
        slot.confidence = '低';
      }
    } else {
      if (/(别名|昵称|笔名|第二个名字|命名|自称)/.test(text)) {
        slot.key = 'alias_pending';
        slot.label = '名字/别名待归位';
      } else if (caseFragmentLike || /(流程|步骤|执行|模板|规约|工作流|case|项目)/i.test(text)) {
        slot.key = 'case_pending';
        slot.label = 'CASE片段待归位';
      } else if (looksLikeRuleName((group && group.title) || '', helpers)) {
        slot.key = 'rule_pending';
        slot.label = '规则待归位';
      } else if (/(纪念日|周年|生日|第一次)/.test(text)) {
        slot.key = 'event_pending';
        slot.label = '纪念节点待归位';
      } else {
        slot.key = 'general_pending';
        slot.label = '通用待归位';
        slot.confidence = '低';
      }
    }
    const bucketLabel = lowerType === 'time' || lowerType === 'unknown' ? '待归位' : displayBucket({ type_key: lowerType });
    const path = owner ? `${owner} > ${slot.label}` : `${bucketLabel} > ${slot.label}`;
    return {
      key: slot.key,
      label: slot.label,
      confidence: slot.confidence,
      owner_hint: owner,
      path
    };
  }

  function needsAiReview(item) {
    const badge = displayBadge(item);
    const slot = String((item && item.secondary_slot) || '').trim();
    const slotConfidence = String((item && item.secondary_slot_confidence) || '').trim();
    const owner = String((item && item.slot_owner_hint) || '').trim();
    const reasons = String(((item && item.reasons) || []).join(' ')).trim();
    if (badge === '时间锚待归位' || badge === '未归位' || badge === '事件 / CASE候选') return true;
    if (!slot || slotConfidence === '低') return true;
    if (['记忆治理', '日常片段', '其他事物', '核心人物'].includes(slot)) return true;
    if (!owner) return true;
    if (String((item && item.perspective_risk) || '').trim() !== '低') return true;
    if (/别名归一|类型还不够清楚|暂时挂不到家族|过程\/CASE 片段/.test(reasons)) return true;
    return false;
  }

  function aiPriority(item) {
    if (!needsAiReview(item)) return 'low';
    const badge = displayBadge(item);
    const slot = String((item && item.secondary_slot) || '').trim();
    const confidence = String((item && item.confidence) || '').trim();
    const perspectiveRisk = String((item && item.perspective_risk) || '').trim();
    if (perspectiveRisk === '高') return 'high';
    if (badge === '时间锚待归位' || badge === '未归位' || badge === '事件 / CASE候选') return 'high';
    if (confidence === '低' || ['记忆治理', '日常片段', '其他事物'].includes(slot)) return 'high';
    if (perspectiveRisk === '中') return 'medium';
    return 'medium';
  }

  function buildDiagnostics(groups, helpers) {
    const h = helpers || {};
    return (groups || []).map((group) => {
      const windowSet = new Set();
      const topicSet = new Set();
      const familySet = new Set();
      let stableFactRows = 0;
      let evidenceTotal = 0;
      group.rows.forEach((row) => {
        splitTokens(row.source_window_id).forEach((item) => windowSet.add(item));
        splitTokens(row.topic_ids).forEach((item) => topicSet.add(item));
        if (row.family_id || row.family_anchor_title) familySet.add(row.family_id || row.family_anchor_title);
        if (String(row.stable_points || '').trim()) stableFactRows += 1;
        evidenceTotal += helperToSafeInt(h, row.evidence_count, 0, 0);
      });
      const typeKey = normalizeCardType(group.cardType);
      const nameQuality = !isGenericName(group.title, h);
      const crossMonthSignal = group.files.size >= 2 || (group.rows.length >= 2 && windowSet.size >= 2);
      const maintainable = group.stable > 0 || stableFactRows > 0;
      const explicitType = typeKey !== 'unknown';
      const familyLinkStrength = familySet.size ? 'strong' : 'none';
      const blocked = isMomentaryInference(group.title, (group.rows[0] && group.rows[0].summary) || '', {
        typeKey,
        crossMonthSignal,
        maintainable
      }, h);
      const plainDateName = isPlainDateName(group.title);
      const ruleLikeName = looksLikeRuleName(group.title, h);
      const caseFragmentLike = looksLikeCaseFragment(group.title, (group.rows[0] && group.rows[0].summary) || '');
      let score = 0;
      score += Math.min(group.files.size, 4) * 2;
      score += Math.min(windowSet.size, 4);
      if (nameQuality) score += 2;
      if (maintainable) score += 2;
      if (explicitType) score += 1;
      if (familyLinkStrength === 'strong') score += 1;
      if (typeKey === 'person' || typeKey === 'rule') score += 1;
      if (ruleLikeName && typeKey === 'rule') score += 1;
      if (typeKey === 'time') score -= plainDateName ? 4 : 2;
      if (caseFragmentLike && typeKey === 'event') score -= 1;
      const reasons = [];
      if (crossMonthSignal) reasons.push(`跨月/跨窗信号足够（批次 ${group.files.size}｜窗口 ${windowSet.size}）`);
      else reasons.push(`目前主要还停在单月/单窗（批次 ${group.files.size}｜窗口 ${windowSet.size}）`);
      if (nameQuality) reasons.push('名字可用，后面检索能拿它当入口');
      else reasons.push('名字还偏泛，先别急着当根');
      if (maintainable) reasons.push(`已经有稳定点（stable ${group.stable}｜stable_fact ${stableFactRows}）`);
      else reasons.push('现在更像本月补记，还没有稳定骨点');
      if (familyLinkStrength === 'strong') reasons.push('能挂到已有叙事家族，不是孤岛');
      else reasons.push('暂时挂不到家族，先留观察更稳');
      if (!explicitType) reasons.push('类型还不够清楚，继续观察');
      if (typeKey === 'time') reasons.push(plainDateName ? '它更像普通日期/时间坐标，不该轻易升成主卡' : '时间锚默认先降权，除非后面持续被反复引用');
      if (typeKey === 'rule') reasons.push('这里的规则按可复用约定理解，不只限于关系规则');
      if (caseFragmentLike && typeKey === 'event') reasons.push('它身上有明显过程/CASE 片段味道，后面可能要剥去');
      if (blocked) reasons.push('像情绪瞬时态/推断型画像，不建议升主卡');
      let action = 'archive';
      if (blocked) action = 'blocked';
      else if (typeKey === 'time') {
        action = crossMonthSignal && nameQuality && maintainable && !plainDateName ? 'observe' : 'archive';
      } else if (crossMonthSignal && nameQuality && maintainable) action = 'promote_a';
      else if ((score >= 7 || group.files.size >= 2 || stableFactRows > 0 || familyLinkStrength === 'strong') && !caseFragmentLike) action = 'observe';
      else if (caseFragmentLike && (crossMonthSignal || maintainable)) action = 'observe';
      const confidence = action === 'promote_a'
        ? (score >= 10 ? '高' : '中')
        : action === 'observe'
          ? (score >= 7 ? '中' : '低')
          : '低';
      const hint = placementHint(typeKey, group, {
        crossMonthSignal,
        maintainable
      });
      const slot = secondarySlot(typeKey, group, {
        crossMonthSignal,
        maintainable,
        caseFragmentLike,
        plainDateName,
        isTimeLike: typeKey === 'time'
      }, h);
      const subject = subjectContext(typeKey, group, {
        ownerHint: slot.owner_hint
      });
      if (subject.perspective_risk !== '低') reasons.push(`主体/视角还有漂移风险（${subject.perspective_risk}）`);
      if (subject.depron_hint) reasons.push(subject.depron_hint);
      return {
        key: group.key,
        title: group.title,
        card_type: group.cardType,
        type_key: typeKey,
        versions: group.rows.length,
        batch_count: group.files.size,
        stable: group.stable,
        updated: group.updated,
        volatile: group.volatile,
        first_seen_at: group.firstSeen,
        last_seen_at: group.lastSeen,
        source_window_count: windowSet.size,
        topic_count: topicSet.size,
        family_link_strength: familyLinkStrength,
        evidence_total: evidenceTotal,
        stable_fact_rows: stableFactRows,
        name_quality: nameQuality ? 'good' : 'generic',
        maintainable,
        cross_month_signal: crossMonthSignal,
        explicit_type: explicitType,
        blocked,
        score,
        action,
        action_label: decisionLabel(action),
        confidence,
        placement_hint: hint,
        secondary_slot: slot.label,
        secondary_slot_key: slot.key,
        secondary_slot_confidence: slot.confidence,
        slot_owner_hint: slot.owner_hint,
        slot_path: slot.path,
        subject_focus: subject.subject_focus,
        subject_entities: subject.subject_entities,
        subject_confidence: subject.subject_confidence,
        perspective_risk: subject.perspective_risk,
        perspective_markers: subject.perspective_markers,
        depron_hint: subject.depron_hint,
        leaf_repair_needed: subject.leaf_repair_needed,
        reasons
      };
    }).sort((a, b) => {
      const rank = { promote_a: 0, observe: 1, archive: 2, blocked: 3 };
      if ((rank[a.action] || 9) !== (rank[b.action] || 9)) return (rank[a.action] || 9) - (rank[b.action] || 9);
      if (b.score !== a.score) return b.score - a.score;
      if (b.batch_count !== a.batch_count) return b.batch_count - a.batch_count;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  function buildGroups(rows, helpers) {
    const h = helpers || {};
    const sqlRows = (rows || []).filter((row) => row.layer === 'sql');
    const map = new Map();
    sqlRows.forEach((row) => {
      const key = String(row.growth_key || '').trim();
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, {
          key,
          title: row.card_name || row.title || '未命名 SQL 卡',
          cardType: row.card_type || '未分类',
          rows: [],
          files: new Set(),
          stable: 0,
          updated: 0,
          volatile: 0,
          firstSeen: '',
          lastSeen: ''
        });
      }
      const group = map.get(key);
      group.rows.push(row);
      group.files.add(row.sourceFile || '');
      const evo = String(row.evolution_status || '').trim().toLowerCase();
      if (evo === 'stable') group.stable += 1;
      else if (evo === 'updated') group.updated += 1;
      else group.volatile += 1;
      group.firstSeen = pickEarlierDate(h, group.firstSeen, sqlGrowthDateValue(h, row.first_seen_at || row.time));
      group.lastSeen = pickLaterDate(h, group.lastSeen, sqlGrowthDateValue(h, row.last_seen_at || row.time));
    });
    return Array.from(map.values()).sort((a, b) => {
      if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
      if (b.files.size !== a.files.size) return b.files.size - a.files.size;
      if (b.updated !== a.updated) return b.updated - a.updated;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  window.SqlGrowthDiagnostics = {
    normalizeCardType,
    isPlainDateName,
    looksLikeRuleName,
    looksLikeCaseFragment,
    isGenericName,
    isMomentaryInference,
    placementHint,
    decisionLabel,
    displayBucket,
    displayBadge,
    sourceText,
    ownerHint,
    secondarySlot,
    needsAiReview,
    aiPriority,
    buildDiagnostics,
    buildGroups
  };
})();

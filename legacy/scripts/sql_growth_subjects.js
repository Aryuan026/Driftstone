(function () {
  function sourceText(group) {
    const rows = Array.isArray(group && group.rows) ? group.rows : [];
    const parts = [String((group && group.title) || '').trim()];
    rows.slice(0, 4).forEach((row) => {
      [
        'relation_to_user',
        'summary',
        'text',
        'content_text',
        'stable_points',
        'background',
        'note',
        'reflection_note'
      ].forEach((field) => {
        const value = String((row && row[field]) || '').trim();
        if (value) parts.push(value);
      });
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function uniqueStrings(list, limit = 0) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((item) => {
      const text = String(item || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return limit > 0 ? out.slice(0, limit) : out;
  }

  function normalizeFocusTitle(title) {
    const text = String(title || '').trim();
    if (!text) return '';
    if (/^(user|用户)$/i.test(text)) return 'User';
    if (/^(assistant|companion|bot)$/i.test(text)) return 'Companion';
    if (/^(user_father|父亲|爸爸)$/i.test(text)) return 'User > Family > Father';
    if (/^(user_mother|母亲|妈妈)$/i.test(text)) return 'User > Family > Mother';
    if (/^(user_brother|弟弟)$/i.test(text)) return 'User > Family > Brother';
    if (/^(用户妹妹|妹妹)$/i.test(text)) return 'User > Family > Sister';
    return text;
  }

  function extractEntities(text) {
    const entities = [];
    const add = (label, pattern) => {
      if (pattern.test(text)) entities.push(label);
    };
    add('User', /(\buser\b|用户\b)/i);
    add('Companion', /(\bassistant\b|\bcompanion\b|\bbot\b)/i);
    add('父亲', /(父亲|爸爸|user_father)/i);
    add('母亲', /(母亲|妈妈|user_mother)/i);
    add('弟弟', /(弟弟|user_brother)/i);
    add('妹妹', /(妹妹|用户妹妹)/i);
    return uniqueStrings(entities);
  }

  function perspectiveMarkers(text) {
    const markers = [];
    if (/(^|[^A-Za-z])我(们|的|想|会|要|在|又|更|也|就|还|被|对|把|让|需要|希望|觉得)?/.test(text) || /让我|提醒我|我需要|我希望|我会|我想/.test(text)) {
      markers.push('first_person');
    }
    if (/(^|[^A-Za-z])你(们|的|会|要|在|也|就|还|被|对|把|让)?/.test(text) || /你会|你要|你的/.test(text)) {
      markers.push('second_person');
    }
    if (/(^|[^A-Za-z])(她|他|ta)(们|的|会|要|在|也|就|还|被|对|把|让)?/.test(text)) {
      markers.push('third_person');
    }
    if (/quote_refs:|assistant:|user:/i.test(text)) markers.push('quoted_dialogue');
    if (/(用户|\buser\b)/i.test(text) && /(\bassistant\b|\bcompanion\b|\bbot\b)/i.test(text)) markers.push('mixed_roles');
    return uniqueStrings(markers);
  }

  function depronHint(focus, owner, risk) {
    if (risk === '低') return '';
    if (/User\s*\/\s*Companion/.test(focus || owner || '')) {
      return '先把“我/你”拆回 User / Companion，再判断这张卡挂哪根枝。';
    }
    if (/家庭/.test(focus || owner || '')) {
      return `先把代词改写回${focus || owner}，再决定它是事实、关系还是回响。`;
    }
    if (focus || owner) {
      return `先把“我/你/她/他”改写回${focus || owner}相关表述，再进入事实层。`;
    }
    return '主体还不稳，先去代称化，再判断挂载位置。';
  }

  function inferSubjectContext(typeKey, group, meta = {}) {
    const text = sourceText(group);
    const title = String((group && group.title) || '').trim();
    const owner = String(meta.ownerHint || '').trim();
    const entities = extractEntities(text);
    const markers = perspectiveMarkers(text);
    const aliasLike = /(别名|昵称|笔名|第二个名字|命名|自称|账号昵称|固定人设)/.test(text);
    let focus = '';
    let confidence = '低';
    if (owner) {
      focus = owner;
      confidence = '中';
    }
    if (typeKey === 'person') {
      if (aliasLike && owner) {
        focus = owner;
        confidence = '高';
      } else if (title) {
        focus = normalizeFocusTitle(title);
        confidence = /与|和|\/|>/.test(focus) ? '中' : '高';
      }
    } else if (!focus && entities.length === 1) {
      focus = entities[0];
      confidence = '中';
    } else if (!focus && entities.includes('User') && entities.includes('Companion')) {
      focus = 'User / Companion';
      confidence = '中';
    }
    let risk = '低';
    if (markers.includes('mixed_roles') && (markers.includes('first_person') || markers.includes('second_person'))) {
      risk = '高';
    } else if ((markers.includes('first_person') || markers.includes('second_person') || markers.includes('third_person')) && (focus || entities.length)) {
      risk = '中';
    } else if (markers.includes('quoted_dialogue') && !focus) {
      risk = '中';
    }
    if (/与|和|\/|关系|伴侣|共生|老公|恋人/.test(title) && typeKey === 'person') {
      risk = risk === '低' ? '中' : '高';
    }
    return {
      subject_focus: focus,
      subject_entities: entities,
      subject_confidence: confidence,
      perspective_risk: risk,
      perspective_markers: markers,
      depron_hint: depronHint(focus, owner, risk),
      leaf_repair_needed: risk !== '低'
    };
  }

  window.SqlGrowthSubjects = {
    inferSubjectContext
  };
})();

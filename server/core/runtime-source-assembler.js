function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeTimestamp(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 1e15) return Math.floor(num / 1000000);
  if (num >= 1e11) return Math.floor(num / 1000);
  return Math.floor(num);
}

function parseFlexibleTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return normalizeTimestamp(num);
  const parsed = Date.parse(String(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed / 1000);
}

function normalizePositiveIndex(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.max(0, Number(fallback || 0));
  const normalized = Math.floor(num);
  return normalized > 0 ? normalized : Math.max(0, Number(fallback || 0));
}

function normalizeMessage(msg = {}, fallback = {}) {
  const rawTs = msg?.create_time
    || msg?.ts
    || msg?.timestamp
    || msg?.time
    || msg?.metadata?.timestamp
    || msg?.metadata?.timestamp_;

  const role = safeText(
    msg?.role
      || msg?.author?.role
      || fallback.role
      || 'assistant'
  );

  const content = safeText(
    Array.isArray(msg?.content?.parts)
      ? msg.content.parts.join('\n')
      : msg?.content?.text
        || msg?.content
        || msg?.text
        || msg?.message
        || ''
  );

  return {
    role,
    content,
    ts: parseFlexibleTimestamp(rawTs),
    source_window_id: safeText(
      msg?.source_window_id
        || msg?.sourceWindowId
        || msg?.metadata?.source_window_id
        || msg?.metadata?.sourceWindowId
        || fallback.source_window_id
        || ''
    ),
    source_window_title: safeText(
      msg?.source_window_title
        || msg?.sourceWindowTitle
        || msg?.metadata?.source_window_title
        || msg?.metadata?.sourceWindowTitle
        || fallback.source_window_title
        || ''
    ),
    source_msg_index: normalizePositiveIndex(
      msg?.source_msg_index
        || msg?.sourceMsgIndex
        || msg?.metadata?.source_msg_index
        || msg?.metadata?.sourceMsgIndex
        || fallback.source_msg_index,
      fallback.source_msg_index
    )
  };
}

function mergeWindowRanges(messages = []) {
  const byWindow = new Map();
  for (const msg of messages) {
    const windowId = safeText(msg?.source_window_id || '');
    const windowTitle = safeText(msg?.source_window_title || windowId);
    if (!windowId && !windowTitle) continue;
    const key = windowId || windowTitle;
    if (!byWindow.has(key)) {
      byWindow.set(key, {
        source_window_id: windowId || key,
        source_window_title: windowTitle || key,
        start_msg_index: 0,
        end_msg_index: 0,
        message_count: 0
      });
    }
    const bucket = byWindow.get(key);
    const msgIndex = normalizePositiveIndex(msg?.source_msg_index, bucket.message_count + 1);
    if (!bucket.start_msg_index || (msgIndex && msgIndex < bucket.start_msg_index)) bucket.start_msg_index = msgIndex;
    if (msgIndex > bucket.end_msg_index) bucket.end_msg_index = msgIndex;
    bucket.message_count += 1;
  }
  return Array.from(byWindow.values());
}

function mergedBundleMeta(bundle = []) {
  const titles = [];
  const ids = [];
  const refs = [];
  bundle.forEach((item, index) => {
    const title = safeText(item?.title || item?.window_title || `Conversation ${index + 1}`);
    if (title) titles.push(title);
    const id = safeText(item?.id || item?.window_id || `conv_${index + 1}`);
    if (id) ids.push(id);
    const sourceRef = safeText(item?.source_ref || '');
    if (sourceRef) refs.push(sourceRef);
  });
  const uniqTitles = Array.from(new Set(titles));
  const uniqIds = Array.from(new Set(ids));
  const uniqRefs = Array.from(new Set(refs));
  return {
    title: `跨窗口时间拼接 · ${uniqTitles.length || bundle.length} 窗口`,
    source_ref: uniqRefs.join(' | ') || 'merged_timeline_by_timestamp',
    source_windows: uniqTitles,
    source_window_count: uniqTitles.length || bundle.length,
    source_bundle_id: uniqIds.join('|')
  };
}

export function buildMergedTimelineBundle(bundle = []) {
  const list = Array.isArray(bundle) ? bundle : [];
  if (!list.length) return [];

  const meta = mergedBundleMeta(list);
  const mergedMessages = [];
  let order = 0;

  list.forEach((item, bundleIndex) => {
    const fallback = {
      source_window_id: safeText(item?.id || item?.window_id || `conv_${bundleIndex + 1}`),
      source_window_title: safeText(item?.title || item?.window_title || `Conversation ${bundleIndex + 1}`),
      source_msg_index: 0
    };
    const messages = Array.isArray(item?.messages) ? item.messages : [];
    messages.forEach((msg, index) => {
      const normalized = normalizeMessage(msg, {
        ...fallback,
        source_msg_index: index + 1
      });
      if (!normalized.content) return;
      mergedMessages.push({
        ...normalized,
        _order: order
      });
      order += 1;
    });
  });

  mergedMessages.sort((left, right) => {
    const a = normalizeTimestamp(left.ts);
    const b = normalizeTimestamp(right.ts);
    if (a && b && a !== b) return a - b;
    if (a && !b) return -1;
    if (!a && b) return 1;
    return Number(left._order || 0) - Number(right._order || 0);
  });

  return [{
    title: meta.title,
    source_ref: meta.source_ref,
    source_bundle_id: meta.source_bundle_id,
    source_windows: meta.source_windows,
    source_window_count: meta.source_window_count,
    source_window_ranges: mergeWindowRanges(mergedMessages),
    messages: mergedMessages.map(({ _order, ...rest }) => rest)
  }];
}

export function normalizeIngestBody(body = {}) {
  const normalized = {
    ...body,
    input: body?.input && typeof body.input === 'object'
      ? { ...body.input }
      : {}
  };

  const topBundle = Array.isArray(body?.bundle) ? body.bundle : null;
  const inputBundle = Array.isArray(normalized.input?.bundle) ? normalized.input.bundle : null;
  const bundle = topBundle || inputBundle;
  if (Array.isArray(bundle) && bundle.length > 0) {
    const merged = buildMergedTimelineBundle(bundle);
    if (topBundle) normalized.bundle = merged;
    if (inputBundle) normalized.input.bundle = merged;
  }

  return normalized;
}

export function taskTitle(task) {
  const problem = (task.messages[0]?.text ?? '')
    .replace(/(^|\s)@\S+/g, ' ')
    .replace(/\[(?:模拟)?截图\]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const input = `排障 ${task.id} ${problem || '测试环境问题'}`;
  let title = '';
  for (const character of input) {
    if (Buffer.byteLength(title + character) > 80) break;
    title += character;
  }
  return title.trim();
}

export function ensureTaskTitle(ctx, task, session) {
  // Existing titles may have been chosen by the user: never replace them.
  if (ctx.sessionTitle.get(session)) return false;
  ctx.sessionTitle.rename(session, taskTitle(task));
  return true;
}

export async function repairTaskTitles(ctx, tasks, log = console.log) {
  let repaired = 0;
  for (const task of tasks.filter(t => t.started)) {
    let handle, detach;
    try {
      const live = ctx.sessions.get(task.sessionId);
      if (live) {
        if (ensureTaskTitle(ctx, task, live)) { await ctx.sessions.flush(live); repaired++; }
        task.titleKnown = true;
        continue;
      }
      // A storage-only maintenance operation. Do not resume an Agent: its pending
      // inbox might wake the model or produce group replies during title repair.
      handle = await ctx.sessionPersistence.open(task.sessionId, 'write');
      const restored = await handle.read(0);
      if (restored.events.some(e => e.type === 'session/title' && e.data.title)) { task.titleKnown = true; continue; }
      const session = ctx.sessions.prepare(task.sessionId, {
        seed: restored.events, meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount, eventState: restored.eventState ?? 'detached',
      });
      detach = ctx.sessions.enter(session);
      // Persist restore-generated lifecycle events before published events start
      // routing to this write handle. The backend owns all later live writes.
      const current = await ctx.sessionQuery.readSession(session.id);
      await handle.append(current.events.slice(restored.events.length));
      ctx.sessions.announce(session);
      if (ensureTaskTitle(ctx, task, session)) {
        await ctx.sessions.flush(session);
        repaired++;
      }
      task.titleKnown = true;
    } catch (e) {
      if (e.message.includes('active write handle')) log(`任务 ${task.id} 会话正被其他 Harness 实例占用，释放后重试标题补齐。`);
      else log(`任务 ${task.id} 标题补齐失败：${e.message}`);
    }
    finally {
      detach?.();
      try { await handle?.close(); } catch (e) { log(`任务 ${task.id} 标题维护句柄关闭失败：${e.message}`); }
    }
  }
  return repaired;
}

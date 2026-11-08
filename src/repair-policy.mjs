export function repairPolicy(text, supplied) {
  const block = /```repair-policy\s*\n([\s\S]*?)\n```/.exec(text);
  const policy = supplied ?? (block ? JSON.parse(block[1]) : null);
  if (!policy) return null;
  if (typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(k => !['environments', 'services', 'keys', 'checks', 'publish'].includes(k))) throw new Error('修复授权块字段无效');
  const result = {};
  for (const field of ['environments', 'services', 'keys', 'checks']) {
    if (!Array.isArray(policy[field]) || !policy[field].length || policy[field].length > 50 || !policy[field].every(v => typeof v === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,199}$/.test(v))) throw new Error(`修复授权 ${field} 必须是明确的非空列表，不接受通配符`);
    result[field] = [...new Set(policy[field])].sort();
  }
  if (policy.publish !== true) throw new Error('本版修复授权必须明确 publish:true，执行仍需开发本人逐次确认');
  result.publish = true;
  return result;
}

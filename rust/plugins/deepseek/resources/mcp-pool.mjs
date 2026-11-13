// Wrap native MCP transport configuration at runtime. The native client still
// owns tool registration, resources, prompts and protocol notifications.
export const name = 'nautilo-mcp-pool';
export const inject = ['loader'];
export async function apply(ctx) {
  const address = process.env.NAUTILO_MCP_POOL_ADDR;
  const token = process.env.NAUTILO_MCP_POOL_TOKEN;
  const executable = process.env.NAUTILO_MCP_POOL_EXE;
  if (!address || !token || !executable) return;
  const { scrubbedParentEnv } = await ctx.loader.import('@deepseek-ai/dsh-subprocess');
  const parentEnv = scrubbedParentEnv();
  for (const [key, value] of Object.entries(JSON.parse(process.env.NAUTILO_MCP_PARENT_OVERRIDES || '{}'))) {
    if (value === null) delete parentEnv[key];
    else parentEnv[key] = value;
  }
  for (const key of Object.keys(parentEnv)) {
    if (key.startsWith('NAUTILO_MCP_') || key === 'NAUTILO_CONNECTION_DIRECTORY') delete parentEnv[key];
  }
  const wrap = config => {
    if (typeof config?.command !== 'string' || config.transport && config.transport !== 'stdio' || config.command === executable) return config;
    const spec = {
      transport: 'stdio', command: config.command, args: config.args ?? [],
      cwd: config.cwd || process.cwd(),
      env: { ...parentEnv, ...config.env }, inheritEnv: false,
      scope: process.env.NAUTILO_MCP_SCOPE || '',
    };
    return { ...config, command: executable, args: ['--mcp-relay'], env: {
      ...config.env, NAUTILO_MCP_POOL_ADDR: address, NAUTILO_MCP_POOL_TOKEN: token,
      NAUTILO_MCP_POOL_SPEC: JSON.stringify(spec),
    } };
  };
  ctx.on('internal/config', function (raw, next) {
    const config = next();
    return this.entry?.options.name === '@deepseek-ai/dsh-mcp-client' && this.parent.fiber?.entry !== this.entry ? wrap(config) : config;
  }, { global: true, prepend: true });
}

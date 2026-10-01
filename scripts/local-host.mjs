/** 当前产品没有身份认证，启动时不允许扩展到公网或局域网。 */
export function localNextArgs(args) {
  const result = [...args];
  let found = false;
  for (let index = 0; index < result.length; index++) {
    const argument = result[index];
    if (argument === '--hostname' || argument === '-H' || argument.startsWith('--hostname=') || (argument.startsWith('-H') && argument.length > 2)) {
      const host = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument.startsWith('-H') && argument.length > 2 ? argument.slice(2) : result[++index];
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        throw new Error('织识是无账号的本机单用户产品，请使用 --hostname 127.0.0.1；网络部署需要先增加访问控制。');
      }
      found = true;
    }
  }
  return found ? result : [...result, '--hostname', '127.0.0.1'];
}

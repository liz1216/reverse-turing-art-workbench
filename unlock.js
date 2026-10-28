const form = document.getElementById('unlock-form');
const password = document.getElementById('password');
const button = document.getElementById('unlock');
const status = document.getElementById('status');
const gate = document.getElementById('gate');
const unlocked = document.getElementById('unlocked');
const mount = document.getElementById('mount');
const lock = document.getElementById('lock');
const ITERATIONS = 600000;
const ENVELOPE_FORMAT = 'workbench-envelope';
const ARCHIVE_FORMAT = 'turing-art-workbench';
const base = new URL('.', import.meta.url);
const blobURLs = new Map();
const constructing = new Set();
let files = null;
let generation = 0;

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label}无效`);
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error(`${label}无效`);
  }
}

function normalizedPath(path) {
  let value;
  try { value = decodeURIComponent(String(path)).replaceAll('\\', '/'); }
  catch { throw new Error('资源路径无效'); }
  if (value.includes('\0')) throw new Error('资源路径无效');
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('资源路径越界');
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function pathWithoutSuffix(path) {
  return path.split(/[?#]/, 1)[0];
}

function archiveReference(specifier, from = '', allowBare = false) {
  if (typeof specifier !== 'string') return null;
  const raw = pathWithoutSuffix(specifier);
  if (!raw || (!allowBare && !raw.startsWith('.') && !raw.startsWith('/'))) return null;
  const parent = from ? from.split('/').slice(0, -1) : [];
  const candidate = raw.startsWith('/') ? raw.slice(1) : [...parent, raw].join('/');
  const key = normalizedPath(candidate);
  if (!key) return null;
  const candidates = [key];
  if (!/\.[^/]+$/.test(key)) candidates.push(`${key}.mjs`, `${key}/index.mjs`);
  return candidates.find(item => files && Object.prototype.hasOwnProperty.call(files, item)) || null;
}

function fileText(path, from = '', allowBare = true) {
  const key = archiveReference(path, from, allowBare);
  if (!key || typeof files[key] !== 'string') throw new Error(`找不到工作台文件：${path}`);
  return {key, text: files[key]};
}

function rewriteModuleSpecifiers(source, from) {
  const replace = (whole, prefix, quote, specifier) => {
    const key = archiveReference(specifier, from);
    if (!key || !key.endsWith('.mjs')) return whole;
    return `${prefix}${quote}${moduleURL(key)}${quote}`;
  };
  source = source.replace(/(\bfrom\s*)(["'])([^"']+)\2/g, replace);
  source = source.replace(/(\bimport\s*\(\s*)(["'])([^"']+)\2/g, replace);
  return source.replace(/(\bimport\s*)(["'])([^"']+)\2/g, replace);
}

function moduleURL(path) {
  const {key, text} = fileText(path);
  if (!key.endsWith('.mjs')) throw new Error(`不是模块文件：${path}`);
  const cacheKey = `module:${key}`;
  if (blobURLs.has(cacheKey)) return blobURLs.get(cacheKey);
  if (constructing.has(key)) throw new Error(`模块循环引用：${key}`);
  constructing.add(key);
  try {
    const rewritten = rewriteModuleSpecifiers(text, key);
    const url = URL.createObjectURL(new Blob([rewritten], {type: 'text/javascript'}));
    blobURLs.set(cacheKey, url);
    return url;
  } finally {
    constructing.delete(key);
  }
}

function styleURL(path, from = '') {
  const {key, text} = fileText(path, from);
  if (!key.endsWith('.css')) throw new Error(`不是样式文件：${path}`);
  const cacheKey = `style:${key}`;
  if (blobURLs.has(cacheKey)) return blobURLs.get(cacheKey);
  const url = URL.createObjectURL(new Blob([text], {type: 'text/css'}));
  blobURLs.set(cacheKey, url);
  return url;
}

function rewriteModuleScript(tag, htmlKey) {
  const attributes = tag.slice(tag.indexOf(' '), -1);
  const type = attributes.match(/\btype\s*=\s*(?:(["'])module\1|module)(?=\s|$)/i);
  if (!type) return tag;
  return tag.replace(/\bsrc\s*=\s*(?:(['"])([^'"]+)\1|([^\s>]+))/i, (whole, quote, quoted, bare) => {
    const src = quoted ?? bare;
    const key = archiveReference(src, htmlKey, true);
    return key && key.endsWith('.mjs') ? whole.replace(src, moduleURL(key)) : whole;
  });
}

function rewriteStylesheetLink(tag, htmlKey) {
  if (!/\brel\s*=\s*(?:(["'])stylesheet\1|stylesheet)(?=\s|$)/i.test(tag)) return tag;
  return tag.replace(/\bhref\s*=\s*(?:(['"])([^'"]+)\1|([^\s>]+))/i, (whole, quote, quoted, bare) => {
    const href = quoted ?? bare;
    const key = archiveReference(href, htmlKey, true);
    return key && key.endsWith('.css') ? whole.replace(href, styleURL(key)) : whole;
  });
}

function html(path) {
  const {key, text} = fileText(path);
  if (!key.endsWith('.html')) throw new Error(`不是 HTML 文件：${path}`);
  const rootURL = base.href;
  let result = text.replaceAll('__ROOT__', rootURL);
  result = result.replace(/<script\b[^>]*>/gi, tag => rewriteModuleScript(tag, key));
  return result.replace(/<link\b[^>]*>/gi, tag => rewriteStylesheetLink(tag, key));
}

function clearRuntime() {
  generation += 1;
  window.ART_WORKBENCH?.dispose?.();
  delete window.ART_WORKBENCH;
  for (const url of blobURLs.values()) URL.revokeObjectURL(url);
  blobURLs.clear();
  constructing.clear();
  files = null;
  delete window.workbenchArchive;
  mount.replaceChildren();
  unlocked.hidden = true;
  gate.hidden = false;
  document.body.classList.remove('runtime');
}

function parseArchive(raw) {
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
  if (value?.files && (value.format !== ARCHIVE_FORMAT || value.version !== 1)) throw new Error('工作台版本异常，请刷新');
  const map = value && typeof value.files === 'object' && value.files !== null ? value.files : value;
  if (!map || typeof map !== 'object') throw new Error('工作台内容无效');
  const next = Object.create(null);
  for (const [path, text] of Object.entries(map)) {
    if (!/^(?:[^/]+\/)*[^/]+\.(?:html|mjs|css)$/i.test(path) || path.includes('..')) continue;
    if (typeof text !== 'string') throw new Error('工作台文件无效');
    next[path] = text;
  }
  if (!next['workbench.html'] || !next['app.mjs']) throw new Error('工作台入口缺失');
  return Object.freeze(next);
}

function createAPI() {
  const api = Object.freeze({moduleURL, html});
  window.workbenchArchive = api;
  return api;
}

async function unlock(event) {
  event.preventDefault();
  if (button.disabled || !password.value) return;
  const active = ++generation;
  button.disabled = true;
  status.textContent = '正在解锁…';
  try {
    const response = await fetch(new URL('./content.enc.json', base), {cache: 'no-store'});
    if (!response.ok) throw new Error('页面资源读取失败');
    const envelope = await response.json();
    if (envelope?.format !== ENVELOPE_FORMAT || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA-256' || envelope.iterations !== ITERATIONS) {
      throw new Error('页面版本异常，请刷新');
    }
    const salt = decodeBase64(envelope.salt, '盐值');
    const iv = decodeBase64(envelope.iv, '随机向量');
    const ciphertext = decodeBase64(envelope.ciphertext, '密文');
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('页面参数异常，请刷新');
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('当前浏览器不支持 WebCrypto');
    const material = await subtle.importKey('raw', new TextEncoder().encode(password.value), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS}, material, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    let raw;
    try {
      raw = await subtle.decrypt({name: 'AES-GCM', iv}, key, ciphertext);
    } catch {
      throw new Error('密码不正确，请重新输入');
    }
    if (active !== generation) throw new Error('页面已锁定');
    files = parseArchive(raw);
    const api = createAPI();
    password.value = '';
    mount.innerHTML = api.html('workbench.html');
    await import(api.moduleURL('app.mjs'));
    gate.hidden = true;
    unlocked.hidden = false;
    document.body.classList.add('runtime');
    status.textContent = '';
  } catch (error) {
    clearRuntime();
    password.value = '';
    status.textContent = error instanceof Error && error.message ? error.message : '解锁失败，请刷新重试';
    password.focus();
  } finally {
    button.disabled = false;
  }
}

form.addEventListener('submit', unlock);
lock.addEventListener('click', () => {
  clearRuntime();
  status.textContent = '已重新锁定。';
  password.focus();
});


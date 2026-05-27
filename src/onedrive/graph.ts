import { base64ToBytes, bytesToBase64 } from '@/src/messaging/protocol';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPE = 'User.Read Files.ReadWrite offline_access';
export const DEFAULT_ONEDRIVE_CLIENT_ID = '2113bcce-ee99-4703-b234-55fe2b3932da';

export interface OneDriveConfig {
  clientId: string;
  remotePath: string;
}

export interface OneDriveToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface OneDriveFileStat {
  id: string;
  name: string;
  driveId: string;
  eTag: string;
  cTag: string;
  versionToken: string;
  lastModified: string;
  sizeBytes: number;
}

export interface OneDriveListItem {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  isKdbx: boolean;
  sizeBytes: number;
  lastModified: string;
}

interface GraphDriveItem {
  id?: string;
  name?: string;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  size?: number;
  parentReference?: {
    driveId?: string;
  };
  folder?: unknown;
  file?: unknown;
}

export function normalizeRemotePath(path: string): string {
  return path
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

export function fileNameFromPath(path: string): string {
  const normalized = normalizeRemotePath(path);
  return normalized.split('/').pop() || 'vault.kdbx';
}

export function getRedirectUrl(): string {
  return chrome.identity.getRedirectURL('onedrive');
}

export async function startAuth(clientId: string): Promise<OneDriveToken> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', textBytes(verifier))));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = getRedirectUrl();
  const url = new URL(AUTH);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  const responseUrl = await launchWebAuthFlow(url.toString(), true);
  const returned = new URL(responseUrl);
  const error = returned.searchParams.get('error');
  if (error) throw new Error(returned.searchParams.get('error_description') || error);
  if (returned.searchParams.get('state') !== state) throw new Error('OneDrive authorization state mismatch');
  const code = returned.searchParams.get('code');
  if (!code) throw new Error('OneDrive authorization did not return a code');

  return exchangeToken(clientId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export async function refreshAuth(clientId: string, refreshToken: string): Promise<OneDriveToken> {
  return exchangeToken(clientId, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: getRedirectUrl(),
  });
}

export async function statRemote(accessToken: string, remotePath: string): Promise<OneDriveFileStat | null> {
  const response = await graphFetch(accessToken, metadataUrl(remotePath));
  if (response.status === 404) return null;
  if (!response.ok) throw await graphError(response, 'Unable to read OneDrive file metadata');
  return toStat((await response.json()) as GraphDriveItem);
}

export async function readRemote(accessToken: string, remotePath: string): Promise<string> {
  const response = await graphFetch(accessToken, `${fileUrl(remotePath)}/content`);
  if (!response.ok) throw await graphError(response, 'Unable to download OneDrive vault');
  return bytesToBase64(await response.arrayBuffer());
}

export async function listRemoteDirectory(
  accessToken: string,
  folderPath: string,
): Promise<OneDriveListItem[]> {
  const normalized = normalizeRemotePath(folderPath);
  const url = normalized
    ? `${GRAPH}/me/drive/root:/${encodePath(normalized)}:/children`
    : `${GRAPH}/me/drive/root/children`;
  const response = await graphFetch(accessToken, url);
  if (!response.ok) throw await graphError(response, 'Unable to list OneDrive folder');
  const json = (await response.json()) as { value?: GraphDriveItem[] };
  return (json.value ?? [])
    .map((item) => toListItem(item, normalized))
    .filter((item) => item.isFolder || item.isKdbx)
    .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
}

export async function writeRemote(
  accessToken: string,
  remotePath: string,
  dataBase64: string,
  expectedVersion?: string | null,
): Promise<OneDriveFileStat> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (expectedVersion) headers['If-Match'] = expectedVersion;
  const response = await graphFetch(accessToken, `${fileUrl(remotePath)}/content`, {
    method: 'PUT',
    headers,
    body: base64ToBytes(dataBase64),
  });
  if (response.status === 412) {
    throw new Error('OneDrive remote file changed. Please sync before uploading again.');
  }
  if (!response.ok) throw await graphError(response, 'Unable to upload OneDrive vault');
  return toStat((await response.json()) as GraphDriveItem);
}

export async function sha256Hex(dataBase64: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', base64ToBytes(dataBase64));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function conflictPath(remotePath: string, now = new Date()): string {
  const normalized = normalizeRemotePath(remotePath);
  const parts = normalized.split('/');
  const name = parts.pop() || 'vault.kdbx';
  const dot = name.toLowerCase().endsWith('.kdbx') ? name.length - 5 : name.length;
  const stamp = now
    .toISOString()
    .replaceAll(':', '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');
  parts.push(`${name.slice(0, dot)}.local-conflict-${stamp}.kdbx`);
  return parts.join('/');
}

function metadataUrl(remotePath: string): string {
  return fileUrl(remotePath);
}

function fileUrl(remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  if (!normalized) throw new Error('OneDrive remote path is required');
  return `${GRAPH}/me/drive/root:/${encodePath(normalized)}:`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function graphFetch(
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}

function toStat(item: GraphDriveItem): OneDriveFileStat {
  const eTag = item.eTag || '';
  const cTag = item.cTag || '';
  return {
    id: item.id || '',
    name: item.name || '',
    driveId: item.parentReference?.driveId || '',
    eTag,
    cTag,
    versionToken: eTag || cTag,
    lastModified: item.lastModifiedDateTime || '',
    sizeBytes: item.size || 0,
  };
}

function toListItem(item: GraphDriveItem, parentPath: string): OneDriveListItem {
  const name = item.name || '';
  const path = parentPath ? `${parentPath}/${name}` : name;
  const isFolder = item.folder != null;
  return {
    id: item.id || path,
    name,
    path,
    isFolder,
    isKdbx: !isFolder && name.toLowerCase().endsWith('.kdbx'),
    sizeBytes: item.size || 0,
    lastModified: item.lastModifiedDateTime || '',
  };
}

async function exchangeToken(
  clientId: string,
  params: Record<string, string>,
): Promise<OneDriveToken> {
  const body = new URLSearchParams({ client_id: clientId, scope: SCOPE, ...params });
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw await graphError(response, 'Unable to exchange OneDrive authorization');
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!json.access_token) throw new Error(json.error_description || 'OneDrive token response was missing access token');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  };
}

function launchWebAuthFlow(url: string, interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (responseUrl) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!responseUrl) reject(new Error('OneDrive authorization was cancelled'));
      else resolve(responseUrl);
    });
  });
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function graphError(response: Response, fallback: string): Promise<Error> {
  let detail = '';
  try {
    const json = (await response.json()) as { error?: { message?: string }; error_description?: string };
    detail = json.error?.message || json.error_description || '';
  } catch {
    detail = await response.text().catch(() => '');
  }
  return new Error(detail ? `${fallback}: ${detail}` : `${fallback}: HTTP ${response.status}`);
}

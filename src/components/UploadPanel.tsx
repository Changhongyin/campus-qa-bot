import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import { copy } from '../copy';
import { ApiError, submitUpload } from '../lib/api';

interface UploadPanelProps {
  open: boolean;
  onClose: () => void;
}

const errorMap: Record<string, string> = {
  CONSENT_REQUIRED: '请先确认资料不含个人信息，并同意提交。',
  INVALID_FILE_NAME: '文件名不符合要求，请重命名后重试。',
  UNSUPPORTED_FILE_TYPE: '仅支持 TXT 或 MD 文本文件。',
  FILE_TOO_LARGE: '文件超过 200 KB 限制。',
  CONTENT_REJECTED: '资料内容未通过安全检查，请移除敏感信息后重试。',
  DUPLICATE_CONTRIBUTION: '这份资料已经提交过，感谢你的贡献。',
  UPLOAD_RATE_LIMITED: '提交过于频繁，请稍后再试。',
  GITHUB_NOT_CONFIGURED: '资料接收服务暂未配置，请稍后再试。',
  GITHUB_UPSTREAM_ERROR: '资料服务暂时不可用，请稍后重试。',
  GITHUB_AUTH_FAILED: '资料服务认证失败，请联系维护者。',
  INVALID_PAYLOAD: '提交内容不完整，请检查后重试。',
  FEATURE_REQUIRES_NODE_RUNTIME: '当前部署环境暂不支持资料提交。',
  INTERNAL: '提交失败，请稍后重试。',
};

export function UploadPanel({ open, onClose }: UploadPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  if (!open) return null;

  const accept = async (candidate: File | undefined): Promise<void> => {
    setError(''); setResult('');
    if (!candidate) return;
    if (!/\.(txt|md)$/i.test(candidate.name)) { setError(errorMap.UNSUPPORTED_FILE_TYPE); return; }
    if (candidate.size === 0) { setError('文件不能为空。'); return; }
    if (candidate.size > 200 * 1024) { setError(errorMap.FILE_TOO_LARGE); return; }
    const text = await candidate.text();
    if ((text.match(/\uFFFD/g)?.length ?? 0) / Math.max(text.length, 1) > 0.01) { setError('文件编码异常，请使用 UTF-8 文本。'); return; }
    setFile(candidate); setContent(text);
  };

  const submit = async (): Promise<void> => {
    if (!file || !consent) { setError(!file ? '请选择要提交的资料。' : errorMap.CONSENT_REQUIRED); return; }
    setBusy(true); setError('');
    try {
      const response = await submitUpload({ fileName: file.name, content, consent: true, contributor: name.trim() || undefined, note: note.trim() || undefined });
      setResult(`${response.message}（编号：${response.submissionId}）`);
    } catch (reason: unknown) {
      setError(reason instanceof ApiError ? errorMap[reason.code] ?? '提交失败，请稍后重试。' : '网络连接失败，请稍后重试。');
    } finally { setBusy(false); }
  };

  return <div className="upload-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="upload-panel" role="dialog" aria-modal="true" aria-label={copy.chat.upload} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <header><h2>{copy.chat.upload}</h2><button ref={closeRef} type="button" onClick={onClose} aria-label={copy.chat.back}>×</button></header>
      <p>资料将提交给维护者审核，审核通过后才可能进入校园知识库。</p>
      <p>仅支持 UTF-8 编码的 TXT 或 MD 文件，文件大小不超过 200 KB。请勿提交个人信息或受版权保护的材料。</p>
      <button className="upload-dropzone" type="button" onClick={() => inputRef.current?.click()} onDragOver={(event: DragEvent) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); void accept(event.dataTransfer.files[0]); }}>
        {file ? file.name : '点击选择文件，或将文件拖到这里'}
      </button>
      <input ref={inputRef} data-testid="upload-input" className="sr-only" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event: ChangeEvent<HTMLInputElement>) => void accept(event.target.files?.[0])} />
      <input value={name} maxLength={80} placeholder="显示名称（可选）" onChange={(event) => setName(event.target.value)} />
      <input value={note} maxLength={120} placeholder="备注（可选，一行）" onChange={(event) => setNote(event.target.value)} />
      <label><input data-testid="upload-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> 我确认资料不含个人信息，并同意提交审核。</label>
      {error ? <p className="upload-error">{error}</p> : null}
      {result ? <p className="upload-success">{result}</p> : null}
      <button className="button button--primary" data-testid="upload-submit" type="button" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : '提交资料'}</button>
    </section>
  </div>;
}

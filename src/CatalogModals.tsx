import { useEffect, useState } from "react";
import { api } from "./api";
import type { CatalogDescriptionModel, CatalogPriorityModel, CatalogSources } from "./types";

type Vendor = "glm" | "kimi" | "deepseek";

function ModalFrame(props: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className={`modal ${props.className ?? ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="ghost" onClick={props.onClose}>关闭</button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function CatalogSourceModal(props: {
  vendor: Vendor;
  label: string;
  sources: CatalogSources;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [official, setOfficial] = useState(props.sources[props.vendor].url);
  const [backup, setBackup] = useState(props.sources[props.vendor].backupUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = official !== props.sources[props.vendor].url || backup !== props.sources[props.vendor].backupUrl;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const sources: CatalogSources = {
        ...props.sources,
        [props.vendor]: { url: official.trim(), backupUrl: backup.trim() }
      };
      await api.saveSettings({ catalog: { sources } });
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame title={`${props.label} · 源配置`} onClose={props.onClose} className="source-modal">
      <p className="muted">官方源用于首选拉取；三方源用于 CC Switch 备用拉取。保存地址不会立即拉取或覆盖 catalog。</p>
      <label className="field">
        <span>官方源地址</span>
        <input value={official} onChange={(e) => setOfficial(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span>三方源地址（仅当前厂商）</span>
        <input value={backup} onChange={(e) => setBackup(e.target.value)} spellCheck={false} />
      </label>
      <p className="muted">此三方源仅用于 {props.label} 的备用拉取，不影响其他厂商。</p>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button className="ghost" onClick={props.onClose}>取消</button>
        <button disabled={saving || !dirty || !official.trim() || !backup.trim()} onClick={save}>
          {saving ? "保存中…" : "保存源配置"}
        </button>
      </div>
    </ModalFrame>
  );
}

export function CatalogDescriptionModal(props: {
  name: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [models, setModels] = useState<CatalogDescriptionModel[]>([]);
  const [original, setOriginal] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getCatalogDescriptions(props.name)
      .then((data) => {
        if (cancelled) return;
        setModels(data.models);
        setOriginal(data.models.map((m) => m.description));
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.name]);

  const changedCount = models.filter((m, i) => m.description !== original[i]).length;
  const update = (index: number, description: string) =>
    setModels((prev) => prev.map((m, i) => i === index ? { ...m, description } : m));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.saveCatalogDescriptions(props.name, models.map(({ slug, description }) => ({ slug, description })));
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame title={`${props.name} · 模型描述`} onClose={props.onClose} className="description-modal">
      <p className="muted">逐模型编辑 description，输入内容就是保存后的预览。这里仅修改本地 catalog，推送时以保存后的文件为准。</p>
      {loading && <p className="muted">正在读取模型…</p>}
      {!loading && models.length === 0 && !error && <p className="muted">该文件没有模型。</p>}
      <div className="description-list">
        {models.map((m, index) => (
          <div className="description-row" key={m.slug}>
            <div className="description-model">
              <code>{m.slug}</code>
              <span>{m.displayName}</span>
              {m.description !== original[index] && <span className="tag">待保存</span>}
            </div>
            <textarea
              rows={2}
              value={m.description}
              placeholder="（空描述）"
              aria-label={`${m.slug} 的 description`}
              onChange={(e) => update(index, e.target.value)}
            />
          </div>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions description-actions">
        <span className="muted">{changedCount ? `${changedCount} 项待保存` : "暂无修改"}</span>
        <button className="ghost" onClick={props.onClose}>取消</button>
        <button disabled={saving || loading || changedCount === 0} onClick={save}>
          {saving ? "保存中…" : "保存描述"}
        </button>
      </div>
    </ModalFrame>
  );
}

export function CatalogPriorityModal(props: {
  name: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [models, setModels] = useState<CatalogPriorityModel[]>([]);
  const [original, setOriginal] = useState<number[]>([]);
  const [maxPriority, setMaxPriority] = useState(100);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getCatalogPriorities(props.name)
      .then((data) => {
        if (cancelled) return;
        setModels(data.models);
        setOriginal(data.models.map((m) => m.priority));
        setMaxPriority(data.maxPriority);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.name]);

  const changedCount = models.filter((m, i) => m.priority !== original[i]).length;
  const invalid = models.some((m) => !Number.isInteger(m.priority) || m.priority < 0 || m.priority > maxPriority);
  const update = (index: number, raw: string) => {
    const priority = raw.trim() === "" ? Number.NaN : Number(raw);
    setModels((prev) => prev.map((m, i) => i === index ? { ...m, priority } : m));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.saveCatalogPriorities(props.name, models.map(({ slug, priority }) => ({ slug, priority })));
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame title={`${props.name} · 模型优先级`} onClose={props.onClose} className="priority-modal">
      <p className="muted">设置厂商分段内的相对优先级，数值越小越靠前。允许 0～{maxPriority} 的整数；保存和拉取时会自动应用分段起点。</p>
      {loading && <p className="muted">正在读取模型…</p>}
      {!loading && models.length === 0 && !error && <p className="muted">该文件没有模型。</p>}
      <div className="priority-list">
        {models.map((m, index) => {
          const itemInvalid = !Number.isInteger(m.priority) || m.priority < 0 || m.priority > maxPriority;
          return (
            <div className="priority-row" key={m.slug}>
              <div className="priority-model">
                <code>{m.slug}</code>
                <span>{m.displayName}</span>
              </div>
              <input
                type="number"
                min={0}
                max={maxPriority}
                step={1}
                value={Number.isNaN(m.priority) ? "" : m.priority}
                aria-label={`${m.slug} 的 priority`}
                aria-invalid={itemInvalid}
                onChange={(e) => update(index, e.target.value)}
              />
              {m.priority !== original[index] && <span className="tag">待保存</span>}
            </div>
          );
        })}
      </div>
      {invalid && <p className="error-text">priority 必须是 0～{maxPriority} 之间的整数。</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions description-actions">
        <span className="muted">{changedCount ? `${changedCount} 项待保存` : "暂无修改"}</span>
        <button className="ghost" onClick={props.onClose}>取消</button>
        <button disabled={saving || loading || invalid || changedCount === 0} onClick={save}>
          {saving ? "保存中…" : "保存优先级"}
        </button>
      </div>
    </ModalFrame>
  );
}

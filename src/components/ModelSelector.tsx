import { useEffect, useId, useState } from "react";
import { api, write } from "../client-api";
import type { ModelCatalog, ModelChoice, ModelProvider } from "../shared/types";
import { Icon } from "./Icon";
import "./model-selector.css";

const identity = (choice: ModelChoice) => JSON.stringify([choice.provider, choice.model]);
const matchesProvider = (provider: ModelProvider, id: string) =>
  provider.id === id || provider.aliases?.includes(id);

export function ModelSelector({ value, profile, favorites: initialFavorites, disabled, onChange, onFavoritesSaved }: {
  value: ModelChoice;
  profile?: string;
  favorites: ModelChoice[];
  disabled: boolean;
  onChange: (choice: ModelChoice) => void;
  onFavoritesSaved: () => void;
}) {
  const labelId = useId();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(initialFavorites);
  const [savingFavorite, setSavingFavorite] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<ModelCatalog>(`/models${profile ? `?botId=${encodeURIComponent(profile)}` : ""}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.providers)) throw new Error("Hermes returned an unreadable model catalog.");
        setCatalog(result);
      })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [profile, retry]);

  const favoriteKeys = new Set(favorites.map(identity));
  const query = search.trim().toLowerCase();
  const selectedProvider = catalog?.providers.find((provider) => matchesProvider(provider, value.provider));
  const selectedName = selectedProvider?.name || value.provider;
  const providers = (catalog?.providers || []).map((provider) => ({
    ...provider,
    models: provider.models.filter((model) => `${provider.name} ${model.name}`.toLowerCase().includes(query)),
  })).filter((provider) => provider.models.length > 0 || !query);
  const favoriteChoices = favorites.flatMap((choice) => {
    const provider = catalog?.providers.find((provider) => matchesProvider(provider, choice.provider));
    const model = provider?.models.find((model) => model.id === choice.model);
    return provider && model && `${provider.name} ${model.name}`.toLowerCase().includes(query)
      ? [{ choice, provider, model }] : [];
  });
  const toggleFavorite = async (choice: ModelChoice) => {
    if (savingFavorite) return;
    const key = identity(choice);
    const next = favoriteKeys.has(key) ? favorites.filter((item) => identity(item) !== key) : [...favorites, choice];
    setSavingFavorite(true);
    setFavoriteError("");
    try {
      const result = await write<{ modelFavorites: ModelChoice[] }>("/preferences/models", { modelFavorites: next }, "PUT");
      setFavorites(result.modelFavorites);
      onFavoritesSaved();
    } catch (e) { setFavoriteError((e as Error).message); }
    finally { setSavingFavorite(false); }
  };
  const row = (choice: ModelChoice, name: string, available: boolean, providerName?: string) => {
    const selected = value.model === choice.model && (value.provider === choice.provider ||
      !!catalog?.providers.find((provider) => provider.id === choice.provider && matchesProvider(provider, value.provider)));
    const favorite = favoriteKeys.has(identity(choice)) || favorites.some((item) => item.model === choice.model &&
      !!catalog?.providers.find((provider) => provider.id === choice.provider && matchesProvider(provider, item.provider)));
    // Keep an existing provider alias until the user explicitly chooses another model.
    const favoriteChoice = favorite ? favorites.find((item) => item.model === choice.model &&
      (item.provider === choice.provider || !!catalog?.providers.find((provider) => provider.id === choice.provider && matchesProvider(provider, item.provider))))! : choice;
    return <div className="model-option" key={identity(choice)}>
      <button type="button" className="model-choice" aria-pressed={selected} disabled={disabled || !available}
        onClick={() => onChange(choice)}>
        <span><span className="model-name">{name}</span>{providerName && <small>{providerName}</small>}
          {!available && <small>Reconnect in Hermes to use this model</small>}</span>
        {selected && <Icon name="check" size={18} />}
      </button>
      <button type="button" className="model-favorite" aria-label={`${favorite ? "Remove" : "Add"} ${name} ${favorite ? "from" : "to"} favorites`}
        aria-pressed={favorite} disabled={savingFavorite || favorites.length >= 100 && !favorite}
        onClick={() => void toggleFavorite(favoriteChoice)}>
        <Icon name="star" size={18} filled={favorite} />
      </button>
    </div>;
  };
  return <section className="model-selector" aria-labelledby={labelId}>
    <span className="model-label" id={labelId}>Model</span>
    <details className="model-picker">
      <summary><span><strong>{value.model || "Choose a model"}</strong><small>{selectedName || "Connected providers"}</small></span><Icon name="chevron" size={18} /></summary>
      <div className="model-picker-content">
        <label className="model-search">Search models<input type="search" value={search} placeholder="Find a model or provider"
          onChange={(event) => setSearch(event.target.value)} /></label>
        {loading && <p className="muted" role="status">Loading models from Hermes…</p>}
        {error && <div className="model-load-error"><p role="alert">{error}</p><button type="button" onClick={() => setRetry((n) => n + 1)}>Retry loading models</button></div>}
        {favoriteError && <p className="form-error" role="alert">{favoriteError}</p>}
        {favoriteChoices.length > 0 && <div className="model-favorites"><h3>Favorites</h3>
          {favoriteChoices.map(({ choice, provider, model }) => row(choice, model.name, model.available, provider.name))}</div>}
        {providers.map((provider) => <details className="model-provider" key={`${provider.id}:${!!query}`} open={query ? true : undefined}>
          <summary><Icon name="chevron" size={16} /><span>{provider.name}</span><small>{provider.models.length}</small></summary>
          {provider.warning && <p className="muted model-warning">{provider.warning}</p>}
          {provider.models.map((model) => row({ provider: provider.id, model: model.id }, model.name, model.available))}
          {provider.models.length === 0 && <p className="muted model-warning">No models reported. Check this connection in Hermes.</p>}
        </details>)}
        {!loading && !error && providers.length === 0 && <p className="muted">{query ? "No models match your search." : "No connected models were reported. Connect a provider in Hermes, then retry."}</p>}
        {!loading && !error && (catalog?.providers.length || 0) === 0 && <button type="button" onClick={() => setRetry((n) => n + 1)}>Retry loading models</button>}
      </div>
    </details>
    {value.model && !loading && !error && !selectedProvider?.models.some((model) => model.id === value.model) &&
      <p className="muted model-saved-note">Your saved model is kept. Hermes did not include it in the current catalog.</p>}
    <p className="muted model-saved-note">Model choices come from your connected Hermes providers. Star models to keep them handy.</p>
  </section>;
}

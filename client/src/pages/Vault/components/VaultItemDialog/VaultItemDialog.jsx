import "./styles.sass";
import { useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    KeyRound as IconKeyRound, Lock as IconLock, User as IconUser, Building2 as IconBuilding2, Globe as IconGlobe,
    Server as IconServer, Hash as IconHash, Database as IconDatabase, TextCursorInput as IconTextCursorInput,
    TextAlignStart as IconTextAlignStart,
} from "lucide-react";
import { DialogProvider, DialogCancelButton } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import IconInput from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useTags } from "@/common/contexts/TagContext.jsx";
import { patchRequest, postRequest } from "@/common/utils/RequestUtil.js";
import {
    DB_ENGINES, NAME_PATTERN, TYPE_KEYS, VAULT_TYPES, isSecretMissing, missingFields, ownerKey, toFormFields, toPayloadFields,
} from "../../vaultTypes.js";

const FIELD_INPUTS = {
    username: { labelKey: "vault.fields.username", icon: IconUser },
    origins: { labelKey: "vault.fields.origin", icon: IconGlobe },
    hosts: { labelKey: "vault.fields.hosts", icon: IconGlobe },
    headerName: { labelKey: "vault.fields.headerName", icon: IconTextCursorInput },
    headerTemplate: { labelKey: "vault.fields.headerTemplate", icon: IconTextCursorInput },
    host: { labelKey: "vault.fields.host", icon: IconServer },
    port: { labelKey: "vault.fields.port", icon: IconHash },
    database: { labelKey: "vault.fields.database", icon: IconDatabase },
};

const BINDING_KINDS = [["entry", "vault.bindings.addServer"], ["folder", "vault.bindings.addFolder"], ["tag", "vault.bindings.addTag"]];
const NO_BINDINGS = { entry: [], folder: [], tag: [] };

const groupBindings = (bindings = []) => ({
    entry: bindings.filter((b) => b.kind === "entry").map((b) => b.targetId),
    folder: bindings.filter((b) => b.kind === "folder").map((b) => b.targetId),
    tag: bindings.filter((b) => b.kind === "tag").map((b) => b.targetId),
});

const initialForm = (item, defaultOwner) => {
    const type = item?.type ?? "login";
    return {
        type,
        owner: item ? ownerKey(item) : defaultOwner,
        name: item?.name ?? "",
        description: item?.description ?? "",
        fields: toFormFields(type, item?.fields),
        approvalRequired: item?.approvalRequired ?? true,
        allServers: item?.allServers ?? false,
        bindings: groupBindings(item?.bindings),
    };
};

// Folders keep their path in the label, so two "Produktion" folders stay apart in the picker.
const collectTargets = (nodes, path = []) => nodes.flatMap((node) => {
    if (node.type === "folder") {
        const trail = [...path, node.name];
        return [{ kind: "folder", value: node.id, label: trail.join(" › ") }, ...collectTargets(node.entries || [], trail)];
    }
    return node.type === "server" ? [{ kind: "entry", value: node.id, label: node.name }] : [];
});

const ownerNodes = (servers, owner) => (owner === "personal"
    ? (servers || []).filter((node) => node.type !== "organization")
    : (servers || []).find((node) => node.type === "organization" && node.id === owner)?.entries || []);

// Mount with a fresh `key` per opening: the form is initialised from props once, not synced by an effect.
export const VaultItemDialog = ({ open, onClose, item = null, owners, defaultOwner, onSaved }) => {
    const { t } = useTranslation();
    const { servers } = useContext(ServerContext);
    const { tags } = useTags();
    const [form, setForm] = useState(() => initialForm(item, defaultOwner));
    const [pristine] = useState(() => JSON.stringify(initialForm(item, defaultOwner)));
    const [secrets, setSecrets] = useState({});
    const [showMissing, setShowMissing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [failure, setFailure] = useState(null);

    const spec = VAULT_TYPES[form.type];
    const isEdit = item !== null;
    const payloadFields = toPayloadFields(form.fields);
    const storedFields = item ? toPayloadFields(toFormFields(item.type, item.fields)) : {};
    const targetChanged = isEdit && spec.targets.some((field) =>
        JSON.stringify(payloadFields[field] ?? null) !== JSON.stringify(storedFields[field] ?? null));
    const secretsMissing = isSecretMissing(form.type, secrets);
    const nameValid = NAME_PATTERN.test(form.name);
    const fieldsMissing = missingFields(form.type, payloadFields).length > 0;
    const saveBlocked = saving || !nameValid || fieldsMissing || (targetChanged && secretsMissing);

    const targets = useMemo(() => {
        const found = collectTargets(ownerNodes(servers, form.owner));
        const options = {
            entry: found.filter((target) => target.kind === "entry"),
            folder: found.filter((target) => target.kind === "folder"),
            tag: (tags || []).map((tag) => ({ value: tag.id, label: tag.name })),
        };
        for (const binding of item?.bindings || []) {
            if (!options[binding.kind].some((option) => option.value === binding.targetId)) {
                options[binding.kind].push({ value: binding.targetId, label: binding.label ?? String(binding.targetId) });
            }
        }
        return options;
    }, [servers, tags, form.owner, item]);

    const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
    const setField = (key, value) => setForm((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
    const setBindings = (kind, ids) => setForm((current) => ({ ...current, bindings: { ...current.bindings, [kind]: ids } }));

    const changeType = (type) => {
        setForm((current) => ({ ...current, type, fields: toFormFields(type) }));
        setSecrets({});
    };

    const changeOwner = (owner) => setForm((current) => ({ ...current, owner, bindings: NO_BINDINGS }));

    const isDirty = () => JSON.stringify(form) !== pristine || Object.values(secrets).some(Boolean);

    const submit = async () => {
        if (saveBlocked) return;
        if (!isEdit && secretsMissing) {
            setShowMissing(true);
            return;
        }
        setSaving(true);
        setFailure(null);
        const filled = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value));
        const bindings = Object.entries(form.bindings).flatMap(([kind, ids]) => ids.map((targetId) => ({ kind, targetId })));
        const body = {
            name: form.name, fields: payloadFields, approvalRequired: form.approvalRequired,
            allServers: form.allServers, bindings,
        };
        try {
            const answer = isEdit
                ? await patchRequest(`vault/items/${item.id}`, {
                    ...body, description: form.description.trim() || null,
                    ...(Object.keys(filled).length > 0 ? { secrets: filled } : {}),
                })
                : await postRequest("vault/items", {
                    ...body, type: form.type, secrets: filled,
                    ...(form.description.trim() ? { description: form.description.trim() } : {}),
                    ...(form.owner !== "personal" ? { organizationId: owners.find((o) => o.value === form.owner)?.organizationId } : {}),
                });
            onSaved(answer.item);
            onClose();
        } catch (error) {
            setFailure(error?.code === 409 ? "nameTaken" : "saveFailed");
        } finally {
            setSaving(false);
        }
    };

    const onKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
        }
    };

    const secretPlaceholder = (field, label) => (isEdit && !targetChanged && item.secretFields.includes(field)
        ? t("vault.dialog.secretStored")
        : t("vault.dialog.enterSecret", { field: label }));

    return (
        <DialogProvider open={open} onClose={onClose} isDirty={isDirty}>
            <div className="vault-item-dialog" data-ui-id="UI-VAULT-DIALOG" onKeyDown={onKeyDown}>
                <h2 className="vault-item-dialog-title">
                    <Icon icon={IconKeyRound} />
                    {t(isEdit ? "vault.dialog.title.edit" : "vault.dialog.title.create")}
                </h2>

                <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
                    <div className="vault-item-dialog-body">
                        <div className="vault-item-dialog-grid">
                            <div className="form-group" data-ui-id="UI-VAULT-DIALOG-TYPE">
                                <label>{t("vault.dialog.type")}</label>
                                <SelectBox disabled={isEdit} selected={form.type} setSelected={changeType}
                                           options={TYPE_KEYS.map((key) => ({ value: key, label: t(VAULT_TYPES[key].labelKey), icon: VAULT_TYPES[key].icon }))} />
                                {isEdit && <span className="vault-help">{t("vault.dialog.fixed")}</span>}
                            </div>
                            <div className="form-group" data-ui-id="UI-VAULT-DIALOG-OWNER">
                                <label>{t("vault.dialog.owner")}</label>
                                <SelectBox disabled={isEdit} selected={form.owner} setSelected={changeOwner}
                                           options={owners.map((owner) => ({ ...owner, icon: owner.value === "personal" ? IconUser : IconBuilding2 }))} />
                                {isEdit && <span className="vault-help">{t("vault.dialog.fixed")}</span>}
                            </div>
                        </div>

                        <div className="vault-item-dialog-grid" data-ui-id="UI-VAULT-DIALOG-FIELDS">
                            <div className="form-group">
                                <label htmlFor="vault-name">{t("vault.fields.name")}</label>
                                <IconInput id="vault-name" icon={IconTextCursorInput} customClass="vault-mono" value={form.name}
                                           setValue={(value) => { set("name", value); setFailure(null); }} placeholder="portal-login" />
                                {failure === "nameTaken" && <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.nameTaken")}</span>}
                            </div>
                            {Object.keys(form.fields).map((key) => (key === "engine" ? (
                                <div className="form-group" key={key}>
                                    <label>{t("vault.fields.engine")}</label>
                                    <SelectBox options={DB_ENGINES} selected={form.fields.engine} setSelected={(value) => setField("engine", value)} />
                                </div>
                            ) : (
                                <div className="form-group" key={key}>
                                    <label htmlFor={`vault-field-${key}`}>{t(FIELD_INPUTS[key].labelKey)}</label>
                                    <IconInput id={`vault-field-${key}`} icon={FIELD_INPUTS[key].icon} customClass="vault-mono"
                                               value={form.fields[key]} setValue={(value) => setField(key, value)} />
                                </div>
                            )))}
                            <div className="form-group vault-item-dialog-wide">
                                <label htmlFor="vault-description">{t("vault.fields.description")}</label>
                                <IconInput id="vault-description" icon={IconTextAlignStart} value={form.description}
                                           setValue={(value) => set("description", value)} />
                            </div>
                        </div>

                        <div className="vault-item-dialog-secrets" data-ui-id="UI-VAULT-DIALOG-SECRET">
                            {spec.secrets.map((field) => {
                                const label = t(`vault.secretFields.${field}`);
                                const invalid = showMissing && secretsMissing;
                                return (
                                    <div className="form-group" key={field}>
                                        <label htmlFor={`vault-secret-${field}`}>{label}</label>
                                        {field === "privateKey" ? (
                                            // <input> drops line breaks, which would break a PEM key.
                                            <textarea id="vault-secret-privateKey" className="vault-textarea vault-mono" rows={4}
                                                      spellCheck={false} autoComplete="off" aria-invalid={invalid || undefined}
                                                      placeholder={secretPlaceholder(field, label)} value={secrets.privateKey || ""}
                                                      onChange={(event) => setSecrets((current) => ({ ...current, privateKey: event.target.value }))} />
                                        ) : (
                                            <IconInput id={`vault-secret-${field}`} type="password" icon={IconLock} customClass="vault-mono"
                                                       autoComplete="new-password" placeholder={secretPlaceholder(field, label)}
                                                       value={secrets[field] || ""}
                                                       setValue={(value) => setSecrets((current) => ({ ...current, [field]: value }))} />
                                        )}
                                        {isEdit && !targetChanged && item.secretFields.includes(field) && (
                                            <span className="vault-help">{t("vault.dialog.secretStored")}</span>
                                        )}
                                    </div>
                                );
                            })}
                            {targetChanged && <span className="vault-help vault-help--warning">{t("vault.dialog.secretCleared")}</span>}
                            {showMissing && secretsMissing && <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.secretMissing")}</span>}
                        </div>

                        <div className="form-group" data-ui-id="UI-VAULT-DIALOG-SCOPE">
                            <label>{t("vault.detail.scope")}</label>
                            <div className={`vault-item-dialog-bindings${form.allServers ? " vault-item-dialog-bindings--all" : ""}`}>
                                {BINDING_KINDS.filter(([kind]) => kind !== "tag" || form.owner === "personal").map(([kind, placeholderKey]) => (
                                    <SelectBox key={kind} multiple searchable disabled={form.allServers} options={targets[kind]}
                                               selected={form.bindings[kind]} setSelected={(ids) => setBindings(kind, ids)}
                                               placeholder={t(placeholderKey)} />
                                ))}
                            </div>
                            {!form.allServers && Object.values(form.bindings).every((ids) => ids.length === 0) && (
                                <span className="vault-help">{t("vault.bindings.emptyDialog")}</span>
                            )}
                            <div className="vault-item-dialog-switch">
                                <label htmlFor="vault-all-servers">{t("vault.bindings.allServers")}</label>
                                <ToggleSwitch id="vault-all-servers" checked={form.allServers} onChange={(value) => set("allServers", value)} />
                            </div>
                        </div>

                        <div className="vault-item-dialog-switch" data-ui-id="UI-VAULT-DIALOG-APPROVAL">
                            <label htmlFor="vault-approval">{t("vault.policy.required")}</label>
                            <ToggleSwitch id="vault-approval" checked={form.approvalRequired} onChange={(value) => set("approvalRequired", value)} />
                        </div>
                    </div>

                    <div className="vault-item-dialog-actions">
                        {failure === "saveFailed" && <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.saveFailed")}</span>}
                        <DialogCancelButton text={t("common.actions.cancel")} />
                        <Button dataUiId="UI-VAULT-DIALOG-SAVE" type="primary" buttonType="submit" disabled={saveBlocked}
                                loading={saving}
                                text={saving ? t("vault.dialog.saving") : t(isEdit ? "vault.dialog.save" : "vault.dialog.create")} />
                    </div>
                </form>
            </div>
        </DialogProvider>
    );
};

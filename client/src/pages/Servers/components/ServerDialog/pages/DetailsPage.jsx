import { mdiFormTextbox, mdiIp, mdiEthernet } from "@mdi/js";
import Input from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import IconChooser from "../components/IconChooser";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { getRequest } from "@/common/utils/RequestUtil.js";

const PROTOCOL_OPTIONS = [
    { label: "SSH", value: "ssh" },
    { label: "Telnet", value: "telnet" },
    { label: "RDP", value: "rdp" },
    { label: "VNC", value: "vnc" },
    { label: "SFTP", value: "sftp" },
    { label: "FTP", value: "ftp" },
    { label: "FTPS", value: "ftps" }
];

const DetailsPage = ({name, setName, icon, setIcon, config, setConfig, fieldConfig}) => {
    const { t } = useTranslation();
    const [engines, setEngines] = useState([]);
    useEffect(() => {
        // A failure here is usually not an error to show: GET /engines sits
        // behind SETTINGS_ENGINES, which is not a default permission, so every
        // non-admin gets a 403. Staying quiet leaves the form as it was before
        // engines existed; the state the manifest calls "error" is an OFFLINE
        // engine, not an unreadable list.
        getRequest("engines")
            .then(data => setEngines(data || []))
            .catch(error => console.debug("Engine list unavailable", error?.message));
    }, []);

    const engineOptions = engines.map(e => ({
        label: `${e.name}${e.connected ? "" : " " + t("servers.dialog.engineOffline")}`,
        value: String(e.id),
    }));

    const showEngineSelect = engines.length > 1;
    // UI-SERVER-DIALOG-DETAILS, state error: an engine that is offline. With a
    // single engine there is no select to carry the "(offline)" suffix, and
    // even with several the suffix alone does not say what it means for saving.
    const offlineEngines = engines.filter(e => !e.connected);
    
    return (
        <>
            {offlineEngines.length > 0 && (
                <p className="details-engine-state warning" role="status">
                    {t("servers.dialog.engineOfflineNotice")}
                </p>
            )}
            <div className="name-row">
                <div className="form-group">
                    <label htmlFor="name">{t("servers.dialog.fields.name")}</label>
                    <Input icon={mdiFormTextbox} type="text" placeholder={t("servers.dialog.placeholders.serverName")} 
                           id="name" autoComplete="off" value={name} setValue={setName} />
                </div>
                <div className="form-group">
                    <label>{t("servers.dialog.fields.icon")}</label>
                    <IconChooser selected={icon} setSelected={setIcon} />
                </div>
            </div>

            {showEngineSelect && (
                <div className="form-group">
                    <label>{t("servers.dialog.fields.engine")}</label>
                    <SelectBox
                        options={engineOptions}
                        selected={config.engineId ? String(config.engineId) : engineOptions[0]?.value}
                        setSelected={(value) => setConfig(prev => ({ ...prev, engineId: value }))}
                    />
                </div>
            )}
            
            {fieldConfig.showIpPort && (
                <>
                    <div className="address-row">
                        <div className="form-group">
                            <label htmlFor="ip">{t("servers.dialog.fields.serverIp")}</label>
                            <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.serverIp")} 
                                   id="ip" autoComplete="off" value={config.ip || ""} 
                                   setValue={(value) => setConfig(prev => ({ ...prev, ip: value }))} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="port">{t("servers.dialog.fields.port")}</label>
                            <input type="text" placeholder={t("servers.dialog.placeholders.port")} 
                                   value={config.port || ""} className="small-input" id="port"
                                   onChange={(e) => setConfig(prev => ({ ...prev, port: e.target.value }))} />
                        </div>
                    </div>
                    {fieldConfig.showProtocol && (
                        <div className="form-group">
                            <label>{t("servers.dialog.fields.protocol")}</label>
                            <SelectBox options={PROTOCOL_OPTIONS} selected={config.protocol} 
                                       setSelected={(value) => setConfig(prev => ({ ...prev, protocol: value }))} />
                        </div>
                    )}
                    {config.wakeOnLanEnabled && (
                        <>
                            <div className="form-group">
                                <label htmlFor="macAddress">{t("servers.dialog.fields.macAddress")}</label>
                                <Input icon={mdiEthernet} type="text" placeholder={t("servers.dialog.placeholders.macAddress")}
                                       id="macAddress" autoComplete="off" value={config.macAddress || ""}
                                       setValue={(value) => setConfig(prev => ({ ...prev, macAddress: value }))} />
                            </div>
                            <div className="form-group">
                                <label htmlFor="wolBroadcastAddress">{t("servers.dialog.fields.wolBroadcastAddress")}</label>
                                <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.wolBroadcastAddress")}
                                       id="wolBroadcastAddress" autoComplete="off" value={config.wolBroadcastAddress || ""}
                                       setValue={(value) => setConfig(prev => ({ ...prev, wolBroadcastAddress: value }))} />
                            </div>
                        </>
                    )}
                </>
            )}
        </>
    );
}

export default DetailsPage;
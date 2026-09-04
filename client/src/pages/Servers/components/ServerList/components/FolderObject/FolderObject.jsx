import ProxmoxIcon from "../../assets/proxmox.png";
import "./styles.sass";
import { useContext, useEffect, useRef, useState } from "react";
import { patchRequest } from "@/common/utils/RequestUtil.js";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useDrag, useDrop } from "react-dnd";

export const FolderObject = ({ id, name, nestedLevel, position, onClick, isOpen, renameState, setRenameStateId, organizationId, folderType }) => {
    const inputRef = useRef();

    const { loadServers } = useContext(ServerContext);
    const [nameState, setNameState] = useState(name || "");

    useEffect(() => {
        if (!renameState) {
            setNameState(name || "");
        }
    }, [name, renameState]);

    const isIntegrationNode = folderType === "integration-node";
    const isIntegrationManaged = isIntegrationNode || folderType === "integration-root";

    const [{ opacity }, dragRef] = useDrag({
        type: "folder",
        item: { type: "folder", id, position },
        canDrag: () => !isIntegrationNode,
        collect: monitor => ({
            opacity: monitor.isDragging() ? 0.5 : 1,
        }),
    });

    const acceptsDrop = (item) => !isIntegrationManaged && !item.isIntegrationEntry;

    const [{ isOver }, dropRef] = useDrop({
        accept: ["server", "folder"],
        drop: async (item) => {
            if (item.id === id || !acceptsDrop(item)) return { id };
            try {
                if (item.type === "server") {
                    await patchRequest(`entries/${item.id}/reposition`, { 
                        targetId: null,
                        placement: 'after',
                        folderId: id,
                        organizationId: organizationId
                    });
                    loadServers();
                    return { id };
                }

                await patchRequest(`folders/${item.id}`, { parentId: item.id !== id ? id : undefined });
            } catch (error) {
                console.error("Failed to drop item", error.message);
            }

            loadServers();

            return { id };
        },
        collect: (monitor) => ({
            isOver: monitor.isOver() && monitor.getItem() != null && acceptsDrop(monitor.getItem()),
        }),
    });

    const changeName = () => {
        setNameState(name => {
            patchRequest("folders/" + id, { name }).then(() => {
                loadServers();
                setRenameStateId(null);
            });

            return name;
        });
    };

    useEffect(() => {
        if (renameState) {
            inputRef.current?.focus();
            inputRef.current?.select();

            const handleEnter = (e) => {
                if (e.key === "Enter") changeName();
            };

            document.addEventListener("keydown", handleEnter);
            return () => document.removeEventListener("keydown", handleEnter);
        }
    }, [renameState]);
    return (
        <div className={"folder-object" + (isOver ? " folder-is-over" : "") + (isOpen ? "" : " closed")} data-id={id}
             ref={(node) => dragRef(dropRef(node))} onClick={renameState ? (e) => e.stopPropagation() : onClick}
             style={{ paddingLeft: `${8 + (nestedLevel * 14)}px`, opacity }}>
            {/* The artboard writes a group as a caret and a quiet label, not a
                folder icon and a row (docs/design/mockups/ui-servers.html,
                .entries .group). The caret comes from CSS so it can flip with
                the open state without a second icon. Proxmox keeps its mark:
                that one carries information, the folder icon did not. */}
            {(folderType === 'integration-node' || folderType === 'integration-root') ? (
                <img src={ProxmoxIcon} alt="Proxmox" style={{ width: '1rem', height: '1rem' }} />
            ) : (
                <span className={`folder-caret${isOpen ? "" : " closed"}`} aria-hidden="true" />
            )}
            {!renameState && <p className="truncate-text">{nameState}</p>}
            {renameState && <input type="text" ref={inputRef} value={nameState} onBlur={changeName}
                                   onChange={(e) => setNameState(e.target.value)} />}
        </div>
    );
};
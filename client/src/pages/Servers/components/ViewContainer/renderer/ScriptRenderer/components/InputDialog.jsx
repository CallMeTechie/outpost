import { DialogProvider } from "@/common/components/Dialog";
import { useState, useEffect } from "react";
import Button from "@/common/components/Button";
import IconInput from "@/common/components/IconInput";
import { TextCursorInput as IconTextCursorInput, Send as IconSend, X as IconX, RectangleEllipsis as IconRectangleEllipsis, Lock as IconLock } from "lucide-react";
import Icon from "@/common/components/Icon";
import "./InputDialog.sass";

const InputDialog = ({ open, onSubmit, onCancel, prompt }) => {
    const [inputValue, setInputValue] = useState("");

    useEffect(() => {
        if (prompt) setInputValue(prompt.default || "");
    }, [prompt]);

    const handleSubmit = () => {
        onSubmit(inputValue);
        setInputValue("");
    };

    const handleKeyDown = (e) => {
        if (e.key === "Enter") handleSubmit();
    };

    const handleCancel = () => {
        setInputValue("");
        onCancel?.();
    };

    const selectOption = (option) => onSubmit(option);

    if (!prompt) return null;

    const promptType = prompt.inputType || prompt.type || "input";

    return (
        <DialogProvider open={open} onClose={() => {}} disableClosing={true}>
            <div className="input-dialog">
                <div className="dialog-title">
                    <Icon icon={promptType === "password" ? IconRectangleEllipsis : IconTextCursorInput} />
                    <h2>Input Required</h2>
                </div>

                <div className="dialog-content">
                    <div className="prompt-description">
                        {prompt.prompt}
                    </div>

                    {promptType === "select" ? (
                        <div className="form-group">
                            <label>Select an option</label>
                            <div className="options-container">
                                {prompt.options.map((option, index) => (
                                    <Button key={index} text={option} onClick={() => selectOption(option)} type="secondary" />
                                ))}
                                <Button text="Cancel" icon={IconX} onClick={handleCancel} type="secondary" className="cancel-btn" />
                            </div>
                        </div>
                    ) : promptType === "confirm" ? (
                        <div className="form-group">
                            <label>Confirm action</label>
                            <div className="confirm-actions">
                                <Button text="Yes" icon={IconSend} onClick={() => selectOption("Yes")} />
                                <Button text="No" icon={IconX} onClick={() => selectOption("No")} type="secondary" />
                                <Button text="Cancel" icon={IconX} onClick={handleCancel} type="secondary" />
                            </div>
                        </div>
                    ) : (
                        <div className="form-group">
                            <label>Enter value</label>
                            <IconInput
                                type={promptType === "password" ? "password" : "text"}
                                icon={promptType === "password" ? IconLock : IconTextCursorInput}
                                value={inputValue}
                                setValue={setInputValue}
                                placeholder={promptType === "password" ? "Enter password..." : (prompt.default || "Enter value...")}
                                onKeyDown={handleKeyDown}
                                autoFocus
                            />
                        </div>
                    )}
                </div>

                {(promptType !== "select" && promptType !== "confirm") && (
                    <div className="dialog-actions">
                        <Button onClick={handleCancel} text="Cancel" icon={IconX} type="secondary" />
                        <Button onClick={handleSubmit} text="Submit" icon={IconSend}
                                disabled={promptType === "password" ? !inputValue : !inputValue.trim()} />
                    </div>
                )}
            </div>
        </DialogProvider>
    );
};

export default InputDialog;

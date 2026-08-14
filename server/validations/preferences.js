const Joi = require('joi');

const terminalSchema = Joi.object({
    fontFamily: Joi.string().max(200),
    fontSize: Joi.number().integer().min(10).max(32),
    cursorStyle: Joi.string().valid('block', 'underline', 'bar'),
    cursorBlink: Joi.boolean(),
    smartCopyPaste: Joi.boolean(),
    theme: Joi.string().max(50),
}).unknown(false);

const themeSchema = Joi.object({
    mode: Joi.string().valid('light', 'dark', 'auto', 'oled'),
    accentColor: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/),
    uiScale: Joi.number().min(0.7).max(1.3),
}).unknown(false);

const filesSchema = Joi.object({
    showThumbnails: Joi.boolean(),
    // "list" is the pre-rename name for the detailed view; it still lives in every existing
    // user's stored preference and the client never rewrites it, so it stays valid alongside
    // the three current view names (see viewModes.js on the client for the same fallback).
    defaultViewMode: Joi.string().valid('list', 'details', 'compact', 'grid'),
    showHiddenFiles: Joi.boolean(),
    confirmBeforeDelete: Joi.boolean(),
    dragDropAction: Joi.string().valid('ask', 'copy', 'move'),
}).unknown(false);

const generalSchema = Joi.object({
    language: Joi.string().max(10),
}).unknown(false);

module.exports.preferencesValidation = Joi.object({
    terminal: terminalSchema,
    theme: themeSchema,
    files: filesSchema,
    general: generalSchema,
}).unknown(false);

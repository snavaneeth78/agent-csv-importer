import { createContext, useContext } from "react";

/**
 * Developer mode shows how the importer reached each answer: the matching stage (template, fuzzy, Jev, LLM),
 * scores, timings and spend. Off (the default) is what a customer sees: the same decisions, in plain words.
 */
export const DevModeContext = createContext(false);
export const useDevMode = () => useContext(DevModeContext);

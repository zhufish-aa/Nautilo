// Test-only store fixtures; no desktop bridge or CLI is executed.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter} from 'react-router-dom';
import App from '../../src/renderer/src/App';
import {I18nProvider} from '../../src/renderer/src/lib/i18n';
import {useProvidersStore} from "../../src/renderer/src/stores/providers";
import {useSessionsStore} from '../../src/renderer/src/stores/sessions';
import {useProjectsStore} from '../../src/renderer/src/stores/projects';
import {useAgentsStore} from '../../src/renderer/src/stores/agents';
import {useSettingsStore} from '../../src/renderer/src/stores/settings';
import { useLightboxStore } from "../../src/renderer/src/stores/lightbox";
import {useComposerDraftsStore} from "../../src/renderer/src/stores/composer-drafts";
const qa = {providers:useProvidersStore,sessions:useSessionsStore,projects:useProjectsStore,agents:useAgentsStore,settings:useSettingsStore,drafts:useComposerDraftsStore,lightbox:useLightboxStore};
declare global { interface Window { qa: typeof qa } }
window.qa = qa;
useSettingsStore.setState({onboardingCompleted:true});
createRoot(document.getElementById('root')!).render(<HashRouter><I18nProvider><App /></I18nProvider></HashRouter>);

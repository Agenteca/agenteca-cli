/**
 * Messages of the command line. They are written in English in the code and translated through the
 * catalogs in `src/locales`, registered next to those of `@agenteca/core`.
 * `test/i18n.test.ts` keeps the catalogs complete.
 */
import { msg, registerCatalog, t } from '@agenteca/core';
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import hi from './locales/hi.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };

registerCatalog('fr', fr);
registerCatalog('es', es);
registerCatalog('zh', zh);
registerCatalog('hi', hi);

export { msg, t };

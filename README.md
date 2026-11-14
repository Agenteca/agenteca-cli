# ahub — la CLI d'Agenteca

`ahub` installe et met à jour des paquets d'agents IA (skills, agents, commandes, hooks, serveurs MCP) depuis des dépôts git, et les rend disponibles dans **Claude Code**, **Codex**, **GitHub Copilot** et **Cursor**.

Le format des paquets est **OpenAPM** (`apm.yml`, `apm.lock.yaml`) : un projet géré par `ahub` reste lisible par l'outil `apm`, et inversement.

> État : 0.1.0, non publiée sur npm. Tant que ce n'est pas le cas, la commande d'installation ci-dessous ne fonctionne pas : construisez la CLI depuis les sources (voir « Développement »).

```bash
npm install -g @agenteca/cli
```

## En deux minutes

```bash
ahub add acme/code-review@v1.2.0 --tool claude,cursor
```

`ahub` résout la version, lit le paquet, le scanne, puis **affiche tout ce qui sera écrit** — fichiers, hooks, serveurs MCP — et demande confirmation. Rien n'est écrit avant.

| Commande | Rôle |
|---|---|
| `ahub init` | Crée `apm.yml`. |
| `ahub add <paquet…>` | Ajoute et installe. Accepte `propriétaire/dépôt`, `…@tag`, `…#ref`, une URL git, un chemin local, ou `nom@registre`. |
| `ahub install` | Installe ce que décrit le manifeste en rejouant le lockfile. `--frozen` pour la CI. |
| `ahub list` | Paquets installés. |
| `ahub outdated` | Mises à jour disponibles. |
| `ahub update [paquet…]` | Met à jour, dans la limite des plages du manifeste. |
| `ahub remove <paquet…>` | Retire le paquet et tous ses fichiers. |
| `ahub search [termes]` | Cherche dans les registres. |
| `ahub info <paquet>` | Montre le contenu d'un paquet sans l'installer (`--files` pour le texte). |
| `ahub scan [cible]` | Analyse de sécurité ; `--format sarif` pour GitHub code scanning. |
| `ahub registry add\|list\|remove\|export` | Gère les registres ; `export` produit un `marketplace.json` natif. |

Options communes : `--tool` (ou `--target`), `--global`, `--json`, `--yes`, `--dry-run`, `--cwd`.

`owner/repo@tag` est un confort de la ligne de commande : le manifeste reçoit toujours la forme OpenAPM `owner/repo#tag`.

## Garde-fous

- **Scan de sécurité.** Un constat critique (caractères Unicode invisibles, `curl … | sh`) bloque l'installation. Contournement explicite : `--allow-unsafe`.
- **Fichiers modifiés à la main.** `ahub` ne les écrase ni ne les supprime jamais sans accord : question fichier par fichier dans un terminal, `--overwrite <chemin>` ou `--force` sinon.
- **Aucun script exécuté** à l'installation.
- **Hors terminal**, rien n'est appliqué sans `--yes`.

## Sortie `--json` : le contrat

Toutes les intégrations (serveur MCP, extensions VS Code et JetBrains, plugins) pilotent `ahub --json`. Cette sortie est un contrat versionné, décrit par [`schemas/cli-output.v1.schema.json`](schemas/cli-output.v1.schema.json) et vérifié par les tests sur chaque commande.

```json
{
  "schemaVersion": "1.0",
  "command": "add",
  "ok": true,
  "data": {},
  "warnings": [{ "code": "HOOK_EVENT_UNSUPPORTED", "message": "…" }],
  "error": null
}
```

- En `--json`, `ahub` ne pose jamais de question et n'écrit rien sur la sortie d'erreur.
- `error` vaut `null` ou `{ code, message, details }`. Les codes sont stables : `CONFIRMATION_REQUIRED`, `PLAN_CHANGED`, `SCAN_BLOCKED`, `FILE_MODIFIED`, `NOT_FOUND`, `RESOLUTION_FAILED`, `LOCK_MISMATCH`, `NO_TARGET`, `USAGE`…
- **Politique de version.** Ajouter un champ ou une commande incrémente la mineure (`1.x`). Retirer un champ ou en changer le sens incrémente la majeure et change le nom du fichier de schéma. Ignorez les champs que vous ne connaissez pas.
- **Exception.** `ahub scan --format sarif` écrit un document SARIF 2.1.0 brut, pas l'enveloppe.

### Codes de sortie

| Code | Sens |
|---|---|
| 0 | Succès |
| 1 | Erreur |
| 2 | Erreur d'usage, ou aucun outil cible |
| 3 | Refus du scan de sécurité (aussi : `ahub scan` avec constat critique) |
| 4 | Confirmation requise, ou plan changé depuis l'approbation |
| 5 | Fichier modifié à la main |

### Installer en deux temps

Pour une interface qui doit montrer le plan avant d'agir :

```bash
ahub add acme/code-review --tool claude --dry-run --json
```

La réponse contient le plan (`files`, `configFiles`, `executables`, `scan`) et un `planHash`. Après accord de l'utilisateur :

```bash
ahub add acme/code-review --tool claude --yes --expect-plan <planHash> --json
```

Si le contenu a changé entre-temps, `ahub` refuse (`PLAN_CHANGED`) : ce qui est appliqué est exactement ce qui a été montré.

### Client TypeScript

```ts
import { AhubClient } from '@agenteca/cli/client';

const ahub = new AhubClient({ cwd: projectDir });
const plan = await ahub.plan('add', ['acme/code-review'], { tools: ['claude'] });
if (plan.ok) await ahub.apply('add', ['acme/code-review'], plan.data.planHash, { tools: ['claude'] });
```

Le client n'a aucune dépendance : il lance le binaire et lit l'enveloppe.

## Registres

Un registre est un catalogue de paquets. Trois formes sont acceptées :

```bash
ahub registry add https://catalogue.exemple.org
```

```bash
ahub registry add agenteca/agenteca-registry
```

```bash
ahub registry add ./mon-catalogue
```

Un dépôt ou un dossier sert de registre s'il contient un `apm.yml` avec un bloc `marketplace:`, ou un `marketplace.json` au format Claude Code, Copilot CLI, Codex ou Cursor.

La liste des registres est le seul fichier propre à `ahub` : `~/.config/ahub/config.json`.

## Interopérabilité avec `apm`

Vérifiée contre `apm` 0.35.0, dans les deux sens : `apm install` accepte un projet installé par `ahub`, et `ahub` lit et rejoue un projet installé par `apm`.

- Automatisé (`test/interop.test.ts`, activé par `AHUB_INTEROP_APM`) : un paquet local, hors ligne.
- Essayé à la main le 14 novembre 2026 : un paquet dans un sous-dossier d'un dépôt GitHub public, avec un hook et un serveur MCP.

Pour y parvenir, `ahub` écrit comme `apm` trois détails que la spécification laisse ouverts : `repo_url: _local/<dossier>` pour un paquet local, le champ `mcp_target_servers`, et `"type": "stdio"` dans `.mcp.json`. Il lit aussi la forme d'identité d'`apm` (`repo_url` sans hôte, `host` à part).

Limites constatées :

- Les deux outils n'écrivent pas le même fichier pour un agent ou une commande Claude Code (`ahub` ajoute le champ `name:` que la documentation de Claude Code exige). Alterner les deux outils réécrit donc ces fichiers à chaque passage.
- Les hooks ne sont pas gérés de la même façon : `apm` les consigne dans `.claude/apm-hooks.json`, `ahub` dans le lockfile. Un hook posé par l'un n'est pas retiré par l'autre.
- `apm` tient un registre `deployments:` dans le lockfile ; `ahub` le conserve sans le mettre à jour.
- `apm` ne conserve pas l'extension `x-ahub` : après un `apm install`, `ahub` ne sait plus quelles entrées de configuration il avait fusionnées.

En pratique : les deux outils lisent le même projet, mais choisissez-en un pour installer et retirer.

## Développement

Les dépôts `agenteca-*` se développent côte à côte dans un espace de travail npm : `@agenteca/core` doit être construit avant.

```bash
npm install
```

```bash
npm test
```

En CI, `agenteca-core` est cloné à côté de ce dépôt et relié par un espace de travail npm : aucun paquet publié n'est nécessaire.

## Licence

Apache-2.0.

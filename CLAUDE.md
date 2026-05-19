# Restricciones Estrictas de Código (Ahorro Crítico)

- **Prohibido código repetido**: Si editas una función dentro de un archivo grande, muestra ÚNICAMENTE la función modificada o el bloque de cambios. Usa comentarios como `# ... resto del código idéntico ...` para omitir las partes que no cambiaron.
- **Formato Unified Diff**: Siempre que sea posible, responde estructurando los cambios en formato de parches cortos (diff -u), indicando claramente qué líneas se eliminan (-) y cuáles se agregan (+).
- **No repitas la lógica en texto**: Si el cambio es evidente en el código provisto, no agregues una explicación textual debajo repitiendo lo mismo que ya hace el código.
- **Sin marcadores de posición proactivos**: No generes archivos de andamiaje (boilerplate) completos con comentarios `// TODO`. Si falta implementar algo, deja solo la firma del método.

## Aider — Wrappers

| Comando | Arquitecto | Editor | Para qué |
|---------|-----------|--------|----------|
| `aider-deepseek` | — | DeepSeek | Tareas rápidas, refactors simples |
| `aider-sonnet` | 🧠 Sonnet | ✏️ DeepSeek | Bugs complejos, lógica financiera |
| `aider-gemini` | — | Gemini | Contextos grandes, tareas baratas |

- **Architect Mode** (`aider-sonnet`): Sonnet razona y planifica en 1-2 turns → DeepSeek aplica los cambios mecánicamente
- `--map-tokens 512` en todos (~50% menos tokens de mapa del repo vs default 1024)
- `--auto-lint` activo: Ruff corrige formato Python post-edit automáticamente
- `.aiderignore` en la raíz del repo excluye basura (node_modules, mockups, binarios)

**NUNCA cambiar `--map-tokens 512`** sin evaluar el impacto en tokens.

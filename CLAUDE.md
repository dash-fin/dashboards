# Restricciones Estrictas de Código (Ahorro Crítico)

- **Prohibido código repetido**: Si editas una función dentro de un archivo grande, muestra ÚNICAMENTE la función modificada o el bloque de cambios. Usa comentarios como `# ... resto del código idéntico ...` para omitir las partes que no cambiaron.
- **Formato Unified Diff**: Siempre que sea posible, responde estructurando los cambios en formato de parches cortos (diff -u), indicando claramente qué líneas se eliminan (-) y cuáles se agregan (+).
- **No repitas la lógica en texto**: Si el cambio es evidente en el código provisto, no agregues una explicación textual debajo repitiendo lo mismo que ya hace el código.
- **Sin marcadores de posición proactivos**: No generes archivos de andamiaje (boilerplate) completos con comentarios `// TODO`. Si falta implementar algo, deja solo la firma del método.

## Ahorro de Tokens al usar Aider

- **`aider-deepseek`** → deepseek/deepseek-chat (tareas rápidas)
- **`aider-sonnet`** → anthropic/claude-sonnet-4 (tareas complejas)
- **`aider-gemini`** → gemini/gemini-2.5-flash (tareas baratas/grandes)

Los 3 wrappers usan `--map-tokens 512` (~50% menos tokens de mapa del repo vs default 1024). No tocar este flag a menos que el proyecto crezca tanto que Aider no entienda la estructura.

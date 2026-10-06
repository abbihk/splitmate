import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
export default defineConfig([...nextVitals, ...nextTs, globalIgnores(['.next/**', 'node_modules/**', '.local-db/**', 'next-env.d.ts']), { rules: { '@typescript-eslint/no-explicit-any': 'off', 'react-hooks/set-state-in-effect': 'off', 'react-hooks/immutability': 'off' } }]);

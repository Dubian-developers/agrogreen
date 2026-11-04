import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(projectDirectory, "tailwind.config.ts") },
    autoprefixer: {},
  },
};



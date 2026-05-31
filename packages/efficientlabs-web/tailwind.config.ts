import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#050505",
        foreground: "#f5f5f7",
        onyx: {
          light: "#18181b",
          DEFAULT: "#0d0d0d",
          dark: "#050505",
        },
        sterling: {
          light: "#f5f5f7",
          DEFAULT: "#d4d4d8",
          dark: "#71717a",
        },
        cyan: {
          DEFAULT: "#06b6d4",
          light: "#22d3ee",
          dark: "#0891b2",
          dim: "#155e75",
        },
      },
      fontFamily: {
        sans: ["var(--font-outfit)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "cyber-grid": "linear-gradient(to right, rgba(6, 182, 212, 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(6, 182, 212, 0.04) 1px, transparent 1px)",
      },
      boxShadow: {
        "glow-cyan": "0 0 20px rgba(6, 182, 212, 0.15)",
        "glow-cyan-strong": "0 0 35px rgba(6, 182, 212, 0.35)",
        "glow-onyx": "0 0 25px rgba(0, 0, 0, 0.75)",
      },
      animation: {
        "pulse-cyan": "pulse-cyan 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-border": "glow-border 4s linear infinite",
        "fade-in-up": "fade-in-up 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards",
      },
      keyframes: {
        "pulse-cyan": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: ".6", transform: "scale(1.02)" },
        },
        "glow-border": {
          "0%, 100%": { borderColor: "rgba(6, 182, 212, 0.15)" },
          "50%": { borderColor: "rgba(6, 182, 212, 0.6)" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;

/** @type {import('tailwindcss').Config} */
import wellmadePreset from 'wellmade-tailwind-preset';

export default {
    presets: [wellmadePreset],
    content: [
        './index.html',
        './src/**/*.{js,ts,jsx,tsx}',
    ],
};

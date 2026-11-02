// index.html 에서 쓰는 Tailwind 클래스만 골라 tailwind.css 로 미리 빌드한다.
// index.html 에 새 Tailwind 클래스를 추가/변경했다면 저장소 루트에서 아래 명령을 다시 실행하고 tailwind.css 를 함께 커밋할 것:
//
//   npx tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify
//
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html"],
  theme: { extend: {} },
  plugins: [],
};

# Fix stripThink.ts yielding
sed -i 's/await new Promise(resolve => setTimeout(resolve, 0));/await new Promise(resolve => setTimeout(resolve, 10));/g' src/utils/stripThink.ts

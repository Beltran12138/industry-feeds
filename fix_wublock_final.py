with open('scraper.js', 'r',encoding='utf-8') as f:
  lines = f.readlines()

# 在第 590 行前插入 results.push 邏輯
push_code = '''       results.push({
        title,
        content: '',
           source: 'WuBlock',
       url: href,
       category: 'HK',
       timestamp: Date.now(),
           is_important: 0
        });
'''

lines.insert(589, push_code)

with open('scraper.js', 'w',encoding='utf-8') as f:
   f.writelines(lines)

print('✅ Added results.push() logic to WuBlock')

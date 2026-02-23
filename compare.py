import json
import io
import sys

def load_json(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        content = f.read().strip()
        # If it starts with { or ,{ but not [ we wrap it in [ ] to parse as list
        # If the user copy-pasted just the items, it might start with { but end with ]
        if content.startswith(','):
            content = content[1:].strip()
        if content.startswith('{') and content.endswith(']'):
             content = '[' + content
        elif content.startswith('{') and not content.endswith('}'):
             # If it doesn't end with either
             content = '[' + content + ']'
        try:
            return json.loads(content)
        except Exception as e:
            print(f"Error parsing {path}: {e}")
            raise e

def get_messages(c):
    if isinstance(c, list):
        return c
    return c.get('messages', [])

c1 = get_messages(load_json('e:\\Games\\AI DM Project\\Urban Superhero\\cache1.txt'))
c2 = get_messages(load_json('e:\\Games\\AI DM Project\\Urban Superhero\\cache2.txt'))
c3 = get_messages(load_json('e:\\Games\\AI DM Project\\Urban Superhero\\cache3.txt'))

print('--- SYSTEM PROMPT COMPARISON ---')
sys1 = c1[0]['content'] if len(c1) > 0 and c1[0].get('role') == 'system' else ''
sys2 = c2[0]['content'] if len(c2) > 0 and c2[0].get('role') == 'system' else ''
sys3 = c3[0]['content'] if len(c3) > 0 and c3[0].get('role') == 'system' else ''

print(f'Sys1 len: {len(sys1)}, Sys2 len: {len(sys2)}, Sys3 len: {len(sys3)}')
print(f'Sys1 == Sys2: {sys1 == sys2}')
print(f'Sys2 == Sys3: {sys2 == sys3}')

if sys1 != sys2:
    lines1 = set(sys1.split('\n'))
    lines2 = set(sys2.split('\n'))
    print('Lines only in sys1:', len(lines1 - lines2))
    print('Lines only in sys2:', len(lines2 - lines1))

if sys2 != sys3:
    lines2 = set(sys2.split('\n'))
    lines3 = set(sys3.split('\n'))
    print('Lines only in sys2:', len(lines2 - lines3))
    print('Lines only in sys3:', len(lines3 - lines2))

print('\n--- MESSAGE COUNTS ---')
print(f'Cache1: {len(c1)} messages')
print(f'Cache2: {len(c2)} messages')
print(f'Cache3: {len(c3)} messages')

print('\n--- MESSAGES ROLES ---')
print('c1:', [(m.get('role'), len(str(m.get('content', '')))) for m in c1])
print('c2:', [(m.get('role'), len(str(m.get('content', '')))) for m in c2])
print('c3:', [(m.get('role'), len(str(m.get('content', '')))) for m in c3])

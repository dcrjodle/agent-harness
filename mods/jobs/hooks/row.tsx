// One job's row, drawn on the surface so a click reports its button and modifier keys: what a highlight and a context menu need.

import type { ClientModule } from 'claude-code'

type RowProps = {
  id: string
  title: string
  meta: string
  glyph: string
  tone: string
  isSelected: boolean
  isMenuOpen: boolean
}

/** The marker's columns at the row's left edge: a click there highlights instead of opening. */
const MARKER = 2

export const Row: ClientModule<RowProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  const say = (button: string, x: number, isShift: boolean, isToggle: boolean): void =>
    surface.post({ kind: 'row', id: props.id, button, isShift, isToggle: isToggle || x < MARKER })

  surface.onPointer(event => {
    if (event.type !== 'down') return

    say(event.button ?? 'left', event.x, event.shift === true, event.ctrl === true || event.alt === true)
  })

  surface.onKey(event => {
    if (event.key === 'return') say('left', MARKER, false, false)
    if (event.key === ' ' || event.key === 'space') say('left', 0, event.shift === true, true)
    if (event.key === 'm') say('right', MARKER, false, false)
  })

  const ground = props.isSelected || props.isMenuOpen ? 'userMessageBackground' : undefined

  return (
    <Box flexDirection="column" width="100%" backgroundColor={ground}>
      <Box flexDirection="row" width="100%">
        <Text color="claude" dimColor={!props.isSelected}>
          {props.isSelected ? '✓ ' : '· '}
        </Text>
        <Text color={props.tone}>{props.glyph} </Text>
        <Text bold wrap="truncate-end">
          {props.title}
        </Text>
      </Box>
      <Box flexDirection="row" width="100%" paddingLeft={MARKER + 2}>
        <Text dimColor wrap="truncate-end">
          {props.meta}
        </Text>
      </Box>
    </Box>
  )
}

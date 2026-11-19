import type { GisA2UIComponentName } from './catalog.js'

/**
 * Headless UI behavior specification mapping each gisknife A2UI component
 * to Vercel UI SDK (`@ui-sdk/core`) accessible primitive contracts so renderers
 * in Vue 3, React, or Web Components share identical keyboard, focus, and ARIA rules.
 */
export interface UiSdkBehaviorSpec {
  component: GisA2UIComponentName
  primitives: string[]
  role: string
  keyboardShortcuts: string[]
  focusTrap: boolean
}

export const GIS_UI_SDK_BEHAVIORS: Record<GisA2UIComponentName, UiSdkBehaviorSpec> = {
  MapBBoxPicker: {
    component: 'MapBBoxPicker',
    primitives: ['Dialog', 'ToggleGroup', 'Popover'],
    role: 'region',
    keyboardShortcuts: ['Escape:cancel', 'Enter:confirmSelection'],
    focusTrap: false,
  },
  CrsDisambiguator: {
    component: 'CrsDisambiguator',
    primitives: ['AlertDialog', 'RadioGroup', 'Button'],
    role: 'alertdialog',
    keyboardShortcuts: ['ArrowUp/ArrowDown:selectOption', 'Enter:confirm', 'Escape:dismiss'],
    focusTrap: true,
  },
  PlaceDisambiguator: {
    component: 'PlaceDisambiguator',
    primitives: ['Select', 'Listbox', 'Popover'],
    role: 'listbox',
    keyboardShortcuts: ['ArrowUp/ArrowDown:navigate', 'Enter:chooseCandidate'],
    focusTrap: false,
  },
  GeoSummaryCard: {
    component: 'GeoSummaryCard',
    primitives: ['Card', 'Collapsible', 'Tooltip'],
    role: 'region',
    keyboardShortcuts: ['Tab:focusActions'],
    focusTrap: false,
  },
  LayerQaReport: {
    component: 'LayerQaReport',
    primitives: ['Accordion', 'Badge', 'ScrollArea'],
    role: 'region',
    keyboardShortcuts: ['Enter/Space:expandIssue'],
    focusTrap: false,
  },
  ExportDeliveryCard: {
    component: 'ExportDeliveryCard',
    primitives: ['Menu', 'Button', 'Tooltip'],
    role: 'group',
    keyboardShortcuts: ['Enter:triggerAction'],
    focusTrap: false,
  },
}

export function getUiSdkBehaviorSpec(component: GisA2UIComponentName): UiSdkBehaviorSpec {
  return GIS_UI_SDK_BEHAVIORS[component]
}

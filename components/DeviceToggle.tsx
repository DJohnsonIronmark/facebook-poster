'use client';

export default function DeviceToggle({
  value, onChange,
}: { value: 'desktop' | 'mobile'; onChange: (v: 'desktop' | 'mobile') => void }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5 text-sm" role="group" aria-label="Preview size">
      {(['desktop', 'mobile'] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          aria-pressed={value === d}
          className={`px-3 py-1 rounded-md capitalize ${value === d ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

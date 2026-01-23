'use client';

import { useState, useMemo } from 'react';

interface PostFiltersProps {
  locations: { location_number: string | null; franchise_name: string }[];
  onFilterChange: (filters: FilterState) => void;
}

export interface FilterState {
  location: string;
  dateFrom: string;
  dateTo: string;
}

export default function PostFilters({ locations, onFilterChange }: PostFiltersProps) {
  const [location, setLocation] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Get unique locations for dropdown
  const uniqueLocations = useMemo(() => {
    const seen = new Set<string>();
    return locations.filter(loc => {
      const key = loc.location_number || loc.franchise_name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => {
      const aLabel = a.location_number ? `${a.location_number} - ${a.franchise_name}` : a.franchise_name;
      const bLabel = b.location_number ? `${b.location_number} - ${b.franchise_name}` : b.franchise_name;
      return aLabel.localeCompare(bLabel);
    });
  }, [locations]);

  const handleLocationChange = (value: string) => {
    setLocation(value);
    onFilterChange({ location: value, dateFrom, dateTo });
  };

  const handleDateFromChange = (value: string) => {
    setDateFrom(value);
    onFilterChange({ location, dateFrom: value, dateTo });
  };

  const handleDateToChange = (value: string) => {
    setDateTo(value);
    onFilterChange({ location, dateFrom, dateTo: value });
  };

  const clearFilters = () => {
    setLocation('');
    setDateFrom('');
    setDateTo('');
    onFilterChange({ location: '', dateFrom: '', dateTo: '' });
  };

  const hasFilters = location || dateFrom || dateTo;

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-4">
      <div className="flex flex-wrap items-end gap-4">
        {/* Location Filter */}
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="location-filter" className="block text-sm font-medium text-gray-700 mb-1">
            Location
          </label>
          <select
            id="location-filter"
            value={location}
            onChange={(e) => handleLocationChange(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All Locations</option>
            {uniqueLocations.map((loc, index) => (
              <option
                key={index}
                value={loc.location_number || loc.franchise_name}
              >
                {loc.location_number ? `${loc.location_number} - ${loc.franchise_name}` : loc.franchise_name}
              </option>
            ))}
          </select>
        </div>

        {/* Date From Filter */}
        <div className="min-w-[160px]">
          <label htmlFor="date-from" className="block text-sm font-medium text-gray-700 mb-1">
            From Date
          </label>
          <input
            type="date"
            id="date-from"
            value={dateFrom}
            onChange={(e) => handleDateFromChange(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* Date To Filter */}
        <div className="min-w-[160px]">
          <label htmlFor="date-to" className="block text-sm font-medium text-gray-700 mb-1">
            To Date
          </label>
          <input
            type="date"
            id="date-to"
            value={dateTo}
            onChange={(e) => handleDateToChange(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* Clear Filters Button */}
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Clear Filters
          </button>
        )}
      </div>
    </div>
  );
}

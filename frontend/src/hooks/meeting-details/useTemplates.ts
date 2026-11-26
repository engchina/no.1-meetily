import { useState, useEffect, useCallback } from 'react';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';

export function useTemplates() {
  const [availableTemplates, setAvailableTemplates] = useState<Array<{
    id: string;
    name: string;
    description: string;
  }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('standard_meeting');

  // Fetch available templates on mount
  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const templates = await invokeTauri('api_list_templates') as Array<{
          id: string;
          name: string;
          description: string;
        }>;
        console.log('Available templates:', templates);
        setAvailableTemplates(templates);
      } catch (error) {
        console.error('Failed to fetch templates:', error);
      }
    };
    fetchTemplates();
  }, []);

  // Handle template selection
  const handleTemplateSelection = useCallback((templateId: string, templateName: string) => {
    setSelectedTemplate(templateId);
    toast.success('Template selected', {
      description: `Using "${templateName}" template for summary generation`,
    });
    Analytics.trackFeatureUsed('template_selected');
  }, []);

  return {
    handleTemplateDeleted(id: string) {
      setAvailableTemplates(current => current.filter(t => t.id !== id));
      setSelectedTemplate(current => current === id ? 'standard_meeting' : current);
      toast.success('Template deleted');
    },
    handleTemplateSaved(template: {id: string; name: string; description: string}) {
      setAvailableTemplates(current => [...current.filter(t => t.id !== template.id), template]
        .sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedTemplate(template.id);
      toast.success('Template saved', { description: `Using "${template.name}" for this meeting.` });
    },
    availableTemplates,
    selectedTemplate,
    handleTemplateSelection,
  };
}

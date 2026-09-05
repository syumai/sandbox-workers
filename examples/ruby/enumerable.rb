puts "Grouping with Enumerable"
return input["words"].group_by(&:length).transform_values(&:sort)
